#!/usr/bin/env bash
#
# Cold: one-shot setup on Cloudflare (https://cold.cleargraph.co)
#
# Run it from your own machine (macOS or Linux; Windows via WSL), where you can log in to Cloudflare:
#
#   bash setup-cloudflare.sh
#
# What it does, in order (safe to re-run; finished steps are skipped):
#   1. Checks prerequisites: git, Node 20+, npm, curl, and a running Docker.
#   2. Uses the Cold checkout it's run from, or clones futurebets/Cold.
#   3. Asks for your Postgres connection string, then generates APP_SECRET and SETUP_TOKEN.
#      All three are saved to ~/.cold/<host>.env with owner-only permissions.
#   4. Logs in to Cloudflare with Wrangler if needed.
#   5. Builds the container and deploys it to cold.cleargraph.co, uploading the secrets with the deploy.
#   6. Waits for https://cold.cleargraph.co/healthz.
#   7. Creates your owner account, and protects cleargraph.co as the primary domain.
#   8. Optionally connects Cloudflare DNS and email validation inside Cold.
#   9. Optionally saves the secrets to GitHub so the deploy workflow can redeploy.
#
# Options:
#   --skip-deploy   Don't build or deploy. Only configure an app that is already running.
#   --url URL       App URL to configure (default https://cold.cleargraph.co).
#   -h, --help      Show this help.
#
# Environment overrides: COLD_HOST, COLD_PRIMARY_DOMAIN, COLD_REPO, COLD_BRANCH, COLD_STATE_DIR,
#                        CLOUDFLARE_ACCOUNT_ID (pick the account when you have several),
#                        WRANGLER_DOCKER_BIN (Podman or another Docker-compatible CLI).

set -euo pipefail

HOST="${COLD_HOST:-cold.cleargraph.co}"
PRIMARY_DOMAIN="${COLD_PRIMARY_DOMAIN:-cleargraph.co}"
REPO="${COLD_REPO:-futurebets/Cold}"
BRANCH="${COLD_BRANCH:-ccr-2cc3eee3-6iiqce}"
STATE_DIR="${COLD_STATE_DIR:-$HOME/.cold}"
APP_URL=""
SKIP_DEPLOY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-deploy) SKIP_DEPLOY=1 ;;
    --url) APP_URL="${2:-}"; shift ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
APP_URL="${APP_URL:-https://$HOST}"
APP_URL="${APP_URL%/}"
STATE_FILE="$STATE_DIR/$HOST.env"

# ───────────── helpers ─────────────
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; D=""; N=""; fi
step() { printf "\n${B}▸ %s${N}\n" "$*"; }
ok()   { printf "  ${G}✓${N} %s\n" "$*"; }
warn() { printf "  ${Y}!${N} %s\n" "$*"; }
info() { printf "  ${D}%s${N}\n" "$*"; }
die()  { printf "\n${R}✗ %s${N}\n" "$*" >&2; exit 1; }

ask() { # ask "Question" "default" → $REPLY
  local q="$1" def="${2:-}"
  if [ -n "$def" ]; then read -r -p "  $q [$def]: " REPLY; REPLY="${REPLY:-$def}"; else read -r -p "  $q: " REPLY; fi
}
ask_secret() { # ask_secret "Question" → $REPLY (hidden)
  read -r -s -p "  $1: " REPLY; echo
}
confirm() { # confirm "Question" [default y|n]
  local def="${2:-n}" a
  if [ "$def" = "y" ]; then read -r -p "  $1 [Y/n]: " a; a="${a:-y}"; else read -r -p "  $1 [y/N]: " a; a="${a:-n}"; fi
  case "$a" in [yY]*) return 0 ;; *) return 1 ;; esac
}
have() { command -v "$1" >/dev/null 2>&1; }
rand_hex() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"; }

TMP_DIR="$(mktemp -d)"
chmod 700 "$TMP_DIR"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT
COOKIES="$TMP_DIR/cookies.txt"

# JSON body from environment variables (no shell quoting pitfalls): json KEY=ENVVAR ...
json() {
  node -e '
    const out = {};
    for (const pair of process.argv.slice(1)) {
      const [k, v] = pair.split("=");
      const val = process.env[v];
      if (val !== undefined && val !== "") out[k] = val === "__true" ? true : val === "__false" ? false : val;
    }
    process.stdout.write(JSON.stringify(out));
  ' "$@"
}

api() { # api METHOD PATH [JSON] → prints body, sets API_STATUS
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -o "$TMP_DIR/body" -w "%{http_code}" -X "$method" -b "$COOKIES" -c "$COOKIES" -H "x-cold-csrf: 1" --max-time 60)
  if [ -n "$body" ]; then args+=(-H "content-type: application/json" --data-binary "$body"); fi
  API_STATUS="$(curl "${args[@]}" "$APP_URL/api$path" || echo 000)"
  cat "$TMP_DIR/body" 2>/dev/null || true
}
api_error() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).error||s)}catch{console.log(s)}})' < "$TMP_DIR/body"; }
json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)['"\"$1\""'];process.stdout.write(v===undefined?"":String(v))}catch{}})'; }

printf "${B}Cold setup on Cloudflare${N}\n"
info "App: $APP_URL · primary domain: $PRIMARY_DOMAIN · state: $STATE_FILE"

# ───────────── 1. prerequisites ─────────────
step "Checking prerequisites"
case "$(uname -s)" in Darwin|Linux) ;; *) die "Run this on macOS or Linux (on Windows, use WSL)." ;; esac
for c in git node npm curl; do have "$c" || die "$c is not installed."; done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 20 or newer is required (you have $(node -v)). Install from https://nodejs.org"
ok "Node $(node -v)"
if [ "$SKIP_DEPLOY" -eq 0 ]; then
  DOCKER_BIN="${WRANGLER_DOCKER_BIN:-docker}"
  have "$DOCKER_BIN" || die "Docker is needed to build the container. Install Docker Desktop, OrbStack or Colima (or set WRANGLER_DOCKER_BIN for Podman)."
  "$DOCKER_BIN" info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop (or OrbStack / Colima) and run this again."
  ok "Docker is running"
  if [ "$(uname -m)" = "arm64" ]; then info "Apple Silicon: the image is built for linux/amd64 under emulation, so the first build can take 5–10 minutes."; fi
fi

# ───────────── 2. code ─────────────
step "Getting the code"
ROOT=""
if git rev-parse --show-toplevel >/dev/null 2>&1 && [ -f "$(git rev-parse --show-toplevel)/infra/cloudflare/wrangler.jsonc" ]; then
  ROOT="$(git rev-parse --show-toplevel)"
  ok "Using the checkout at $ROOT"
elif [ -f "./Cold/infra/cloudflare/wrangler.jsonc" ]; then
  ROOT="$(cd ./Cold && pwd)"
  ok "Using the checkout at $ROOT"
else
  info "Cloning $REPO ($BRANCH) into ./Cold"
  if have gh && gh auth status >/dev/null 2>&1; then
    gh repo clone "$REPO" Cold -- --branch "$BRANCH" --quiet
  else
    git clone --quiet --branch "$BRANCH" "https://github.com/$REPO.git" Cold || die "Couldn't clone $REPO. If it's private, log in with 'gh auth login' (or set up git credentials) and run again."
  fi
  ROOT="$(cd ./Cold && pwd)"
  ok "Cloned to $ROOT"
fi
if [ "$SKIP_DEPLOY" -eq 0 ] && [ -z "$(git -C "$ROOT" status --porcelain)" ]; then
  if git -C "$ROOT" fetch --quiet origin "$BRANCH" 2>/dev/null && git -C "$ROOT" checkout --quiet "$BRANCH" 2>/dev/null && git -C "$ROOT" merge --quiet --ff-only "origin/$BRANCH" 2>/dev/null; then
    ok "Up to date with $BRANCH ($(git -C "$ROOT" rev-parse --short HEAD))"
  else
    warn "Couldn't fast-forward to origin/$BRANCH; deploying the checkout as it is ($(git -C "$ROOT" rev-parse --short HEAD))."
  fi
elif [ "$SKIP_DEPLOY" -eq 0 ]; then
  warn "The checkout has local changes, so I won't update it. Deploying it as it is."
fi
CF_DIR="$ROOT/infra/cloudflare"

# ───────────── 3. secrets ─────────────
step "Secrets"
mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
DATABASE_URL="${DATABASE_URL:-}"; APP_SECRET="${APP_SECRET:-}"; SETUP_TOKEN="${SETUP_TOKEN:-}"
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  ok "Loaded saved secrets from $STATE_FILE"
fi
if [ -z "$DATABASE_URL" ] && [ "$SKIP_DEPLOY" -eq 0 ]; then
  info "Cold stores its data in PostgreSQL (the container's disk is wiped on restart)."
  info "Easiest: create a free project at https://console.neon.tech, then copy its connection string"
  info "(Dashboard → Connect → copy the 'postgresql://…' URL; keep sslmode=require)."
  while :; do
    ask_secret "Paste the Postgres connection string (input hidden)"
    case "$REPLY" in postgres://*|postgresql://*) DATABASE_URL="$REPLY"; break ;; *) warn "That doesn't look like postgres://… — try again." ;; esac
  done
  case "$DATABASE_URL" in *sslmode=*) ;; *\?*) DATABASE_URL="$DATABASE_URL&sslmode=require" ;; *) DATABASE_URL="$DATABASE_URL?sslmode=require" ;; esac
  if have psql; then
    if psql "$DATABASE_URL" -tAc "select 1" >/dev/null 2>&1; then ok "Database connection works"; else warn "psql couldn't connect with that URL. Check it if the deploy doesn't come up."; fi
  fi
fi
if [ "$SKIP_DEPLOY" -eq 0 ]; then
  # Never regenerate APP_SECRET for an existing install: it decrypts credentials stored in the app.
  [ -n "$APP_SECRET" ] || { APP_SECRET="$(rand_hex 32)"; ok "Generated APP_SECRET"; }
  [ -n "$SETUP_TOKEN" ] || { SETUP_TOKEN="$(rand_hex 18)"; ok "Generated SETUP_TOKEN"; }
  (
    umask 077
    {
      echo "# Cold secrets for $HOST. Keep this file: APP_SECRET decrypts credentials stored in the app."
      printf 'DATABASE_URL=%q\n' "$DATABASE_URL"
      printf 'APP_SECRET=%q\n' "$APP_SECRET"
      printf 'SETUP_TOKEN=%q\n' "$SETUP_TOKEN"
    } > "$STATE_FILE"
  )
  ok "Saved to $STATE_FILE (readable only by you). Back it up somewhere safe, like a password manager."
fi

# ───────────── 4–6. deploy ─────────────
if [ "$SKIP_DEPLOY" -eq 0 ]; then
  [ -n "$DATABASE_URL" ] || die "DATABASE_URL is required to deploy."
  step "Installing the deploy tooling"
  (cd "$CF_DIR" && npm ci --no-audit --no-fund --loglevel=error)
  ok "Wrangler $(cd "$CF_DIR" && npx --no-install wrangler --version 2>/dev/null | tail -1)"

  step "Cloudflare login"
  WHO="$(cd "$CF_DIR" && npx --no-install wrangler whoami 2>&1 || true)"
  case "$WHO" in
    *"not authenticated"*)
      info "Opening the browser to log in to Cloudflare…"
      (cd "$CF_DIR" && npx --no-install wrangler login)
      ;;
  esac
  (cd "$CF_DIR" && npx --no-install wrangler whoami 2>&1) | grep -E "logged in|Account Name|Account ID|│" | sed 's/^/  /' | head -12 || true
  ok "Logged in to Cloudflare"
  info "Containers need the Workers Paid plan (\$5/month). The deploy will tell you if it's missing."

  NS="$( (have dig && dig +short NS "$PRIMARY_DOMAIN") || (have nslookup && nslookup -type=NS "$PRIMARY_DOMAIN" 2>/dev/null) || true)"
  case "$NS" in *[Cc][Ll][Oo][Uu][Dd][Ff][Ll][Aa][Rr][Ee]*) NS_OK=1 ;; *) NS_OK=0 ;; esac
  if [ "$NS_OK" -eq 1 ]; then
    ok "$PRIMARY_DOMAIN uses Cloudflare DNS"
  else
    warn "$PRIMARY_DOMAIN doesn't appear to use Cloudflare nameservers. The custom domain $HOST needs the zone in the same Cloudflare account."
    confirm "Deploy anyway?" n || die "Stopped. Add $PRIMARY_DOMAIN to Cloudflare first."
  fi

  step "Building and deploying (this takes a few minutes)"
  SECRETS_FILE="$TMP_DIR/secrets.json"
  ( umask 077; DATABASE_URL="$DATABASE_URL" APP_SECRET="$APP_SECRET" SETUP_TOKEN="$SETUP_TOKEN" json DATABASE_URL=DATABASE_URL APP_SECRET=APP_SECRET SETUP_TOKEN=SETUP_TOKEN > "$SECRETS_FILE" )
  if ! (cd "$CF_DIR" && npx --no-install wrangler deploy --secrets-file "$SECRETS_FILE"); then
    rm -f "$SECRETS_FILE"
    die "Deploy failed. Read the error above. Common causes: Docker not running, no Workers Paid plan, or $PRIMARY_DOMAIN not in this Cloudflare account."
  fi
  rm -f "$SECRETS_FILE"
  ok "Deployed"
fi

step "Waiting for $APP_URL to answer"
info "The first start pulls the image, runs migrations, and Cloudflare issues the certificate. Usually 1–5 minutes."
UP=0
for i in $(seq 1 60); do
  if curl -fsS --max-time 10 "$APP_URL/healthz" >/dev/null 2>&1; then UP=1; break; fi
  printf "."
  sleep 10
done
echo
[ "$UP" -eq 1 ] || die "$APP_URL/healthz didn't answer within 10 minutes. Check the logs with: (cd \"$CF_DIR\" && npx wrangler tail). The usual cause is a wrong DATABASE_URL: fix it in $STATE_FILE and run this again."
ok "$APP_URL is up"

# ───────────── 7. owner account ─────────────
step "Owner account"
STATE_JSON="$(api GET /auth/state)"
NEEDS_SETUP="$(printf "%s" "$STATE_JSON" | json_field needsSetup)"
if [ "$NEEDS_SETUP" = "true" ]; then
  if [ -z "$SETUP_TOKEN" ]; then ask_secret "Setup token (from $STATE_FILE or your deploy)"; SETUP_TOKEN="$REPLY"; fi
  ask "Your name" ""; OWNER_NAME="$REPLY"
  ask "Your email (you'll sign in with it)" ""; OWNER_EMAIL="$REPLY"
  while :; do
    ask_secret "Choose a password (10+ characters)"; P1="$REPLY"
    ask_secret "Repeat it"; P2="$REPLY"
    if [ "$P1" != "$P2" ]; then warn "They don't match."; elif [ "${#P1}" -lt 10 ]; then warn "Use at least 10 characters."; else break; fi
  done
  ask "Company name" "Cleargraph"; COMPANY="$REPLY"
  TZ_DEFAULT="$(node -p 'Intl.DateTimeFormat().resolvedOptions().timeZone' 2>/dev/null || echo America/New_York)"
  ask "Timezone" "$TZ_DEFAULT"; TZ_SEL="$REPLY"
  BODY="$(SETUP_TOKEN="$SETUP_TOKEN" OWNER_NAME="$OWNER_NAME" OWNER_EMAIL="$OWNER_EMAIL" OWNER_PASSWORD="$P1" COMPANY="$COMPANY" PRIMARY="$PRIMARY_DOMAIN" TZ_SEL="$TZ_SEL" \
    json setupToken=SETUP_TOKEN name=OWNER_NAME email=OWNER_EMAIL password=OWNER_PASSWORD workspaceName=COMPANY primaryDomain=PRIMARY timezone=TZ_SEL)"
  api POST /auth/setup "$BODY" >/dev/null
  [ "$API_STATUS" = "200" ] || die "Setup failed ($API_STATUS): $(api_error)"
  P1=""; P2=""
  ok "Owner account created; $PRIMARY_DOMAIN is protected (Cold never sends cold email from it or its subdomains)"
else
  ok "The workspace is already set up"
  if confirm "Sign in to connect integrations now?" y; then
    ask "Email" ""; LOGIN_EMAIL="$REPLY"
    ask_secret "Password"; LOGIN_PW="$REPLY"
    BODY="$(LOGIN_EMAIL="$LOGIN_EMAIL" LOGIN_PW="$LOGIN_PW" json email=LOGIN_EMAIL password=LOGIN_PW)"
    api POST /auth/login "$BODY" >/dev/null
    LOGIN_PW=""
    [ "$API_STATUS" = "200" ] || die "Sign-in failed: $(api_error)"
    ok "Signed in"
  else
    SKIP_INTEGRATIONS=1
  fi
fi

# ───────────── 8. integrations inside Cold ─────────────
if [ "${SKIP_INTEGRATIONS:-0}" -eq 0 ]; then
  step "Connect Cloudflare DNS inside Cold (imports your domains and writes SPF/DKIM/DMARC/MX)"
  info "Create a token at https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom token:"
  info "  Permissions: Zone → Zone → Read, and Zone → DNS → Edit. Zone resources: All zones."
  ask_secret "Paste the Cloudflare API token (Enter to skip)"
  if [ -n "$REPLY" ]; then
    BODY="$(CF_TOKEN="$REPLY" json cloudflareToken=CF_TOKEN)"
    api PUT /integrations "$BODY" >/dev/null
    if [ "$API_STATUS" = "200" ]; then ok "Cloudflare connected"; else warn "Cloudflare token not saved: $(api_error)"; fi
  else
    info "Skipped. You can add it later in Settings → Integrations."
  fi

  step "Email validation (every address is validated before it's emailed)"
  info "MillionVerifier is the cheapest per check: https://app.millionverifier.com/api"
  ask_secret "Paste a MillionVerifier API key (Enter to skip)"
  if [ -n "$REPLY" ]; then
    BODY="$(MV_KEY="$REPLY" MV="millionverifier" json validationProvider=MV validationKey=MV_KEY)"
    api PUT /integrations "$BODY" >/dev/null
    if [ "$API_STATUS" = "200" ]; then ok "Validation connected"; else warn "Not saved: $(api_error)"; fi
  else
    info "Skipped. Lists stay unvalidated (and unsendable) until you add one."
  fi
  api POST /auth/logout "{}" >/dev/null || true
fi

# ───────────── 9. GitHub secrets (optional) ─────────────
if [ "$SKIP_DEPLOY" -eq 0 ] && have gh && gh auth status >/dev/null 2>&1; then
  step "GitHub deploy workflow (optional)"
  if confirm "Save DATABASE_URL, APP_SECRET and SETUP_TOKEN to $REPO so the 'Deploy to Cloudflare' workflow can redeploy?" n; then
    printf "%s" "$DATABASE_URL" | gh secret set DATABASE_URL -R "$REPO"
    printf "%s" "$APP_SECRET" | gh secret set APP_SECRET -R "$REPO"
    printf "%s" "$SETUP_TOKEN" | gh secret set SETUP_TOKEN -R "$REPO"
    ok "Saved. Add CLOUDFLARE_API_TOKEN (Edit Cloudflare Workers + Containers:Edit) and CLOUDFLARE_ACCOUNT_ID as well to deploy from GitHub."
  fi
fi

# ───────────── done ─────────────
printf "\n${G}${B}Done.${N} Open ${B}%s${N}\n\n" "$APP_URL"
cat <<EOF
Next, in the app:
  1. Settings → Integrations → Add tenant: your Microsoft 365 (Hypertide) and/or Google Workspace tenant.
  2. Domains → Add domains → Load my Cloudflare domains → pick your sending domains.
  3. Domains → Write DNS via Cloudflare, paste each DKIM value, pass the header test, Start warmup.
  4. Lists → Upload, Campaigns → New. Domains in the active set start sending once warm (14+ days).

Useful:
  Logs:          (cd "$CF_DIR" && npx wrangler tail)
  Redeploy:      bash "$ROOT/scripts/setup-cloudflare.sh"      (reuses $STATE_FILE)
  Secrets file:  $STATE_FILE   ← keep it safe; APP_SECRET decrypts stored credentials
EOF
