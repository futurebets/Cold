# Cold

Cold is a cold email deliverability platform. It runs the whole sending infrastructure lifecycle and enforces a 14-rule deliverability playbook as **guardrails, not advice**:

> protect the primary domain → provision lookalike domains on Google Workspace or Microsoft 365 → authenticate → warm → enforce caps → clean lists → lint copy → stagger sends → measure health against baselines → diagnose copy vs. infrastructure → rotate in warmed replacements without stopping or losing a reply.

It replaces a paid sequencer such as Instantly: sending and sequences, the unified inbox, analytics, inbox rotation and **warmup** are all built in. You pay only for mailboxes, domains, email validation credits and hosting (≈ $12–35/month on Cloudflare).

The product spec is in [`SPEC.md`](SPEC.md). Its Appendix A maps every playbook rule to the requirements that implement it.

---

## What's built

| Area | What it does |
|---|---|
| **Guardrails** (`packages/core`) | Pure, tested domain logic shared by server and browser: policies with hard gates, caps, capacity planner, DNS/SPF/DKIM/DMARC evaluation, header-test parser, lifecycle gates, list hygiene, copy linter, scheduler, health verdicts, diagnosis decision table, rotation planner, inbound classifier, and the pre-flight guard that every email passes. |
| **Infrastructure** | Protected primary domains, lookalike name suggestions (free RDAP availability), Google/Microsoft tenants, domains and mailboxes within playbook limits, expected DNS records, automatic DNS writes through Cloudflare, live DNS verification, header test (paste headers or automate via seed inboxes), warmup gating (14-day floor, 30 recommended), active/reserve sets, Hypertide vendor tasks. |
| **Lists** | CSV import with auto column mapping. Free checks run first (syntax, dedupe, suppression, MX lookup, Proofpoint/Mimecast/Barracuda removal, disposable domains), so **only survivors are sent to the paid validator** (MillionVerifier or ZeroBounce), with a 30-day cache. Catch-alls get their own bucket and campaign type. Reports the recipient-provider mix. |
| **Campaigns** | Plain-text sequences with live linting (links, images, HTML, placeholders, length, corporate language, hard CTAs, opt-out line, CAN-SPAM postal address), A/B variants, spintax, standalone versions for rotation, sending windows in each recipient's timezone, Saturday test mode, and a launch checklist. Open tracking doesn't exist. |
| **Sending engine** | The planner fills each inbox's remaining daily cap with randomized start times and jittered gaps, interleaving recipient providers and limiting contacts per company. The sender runs the pre-flight guard and an atomic cap counter before every message, through the Gmail API or Microsoft Graph. |
| **Inbox** | Syncs every non-decommissioned mailbox, including Relay and Layover ones. Classifies human replies (positive, question, referral, not interested, opt-out), auto-replies (pauses until the return date), and bounces (hard/soft, by category). Opt-outs and hard bounces are suppressed globally. Unified inbox with in-thread replies. |
| **Health** | Verdicts on the latest 1,000 sends that are at least 48 hours old, against each domain's own baseline (or its peers'). Red = reply < 1% **and** bounce > 3%: the domain pauses automatically and a diagnosis opens. Circuit breakers catch spam-block bursts, bad lists and blocklist hits. |
| **Diagnosis** | Re-checks auth and blocklists, analyzes the bounce mix, then sends neutral control copy and campaign copy from the same inboxes to seed inboxes and reads where each landed. Verdicts: COPY / INFRA / LIST / OFFER / AUTH. Results can also be entered manually from an external placement tool. |
| **Rotation** | Make-before-break: promotes the best warmed reserve domain, moves in-flight sequences, puts the burned domain in Relay so replies keep arriving, falls back to a 15-day Layover when nothing is ready, and creates a replenishment order. |
| **Warmup** | Built in, no warmup subscription. Your inboxes exchange natural, link-free emails with inboxes in your *other* tenants (never inside one tenant, where mail is delivered internally and builds no reputation). Volume ramps from 2/day to 20 (Google) or 10 (Microsoft), and drops to half once an inbox sends cold email. Receivers pull warmup mail out of spam, mark it read and reply to ~35%. Where each email lands becomes the inbox's warmup inbox rate, which gates Ready (≥ 90%) and raises an early warning when an active domain's warmup mail starts hitting spam. You can switch to an external warmup tool instead. |
| **Ops** | Roles (Owner, Operator, SDR, Viewer), audit log, encrypted secrets (AES-256-GCM), Slack alerts, job status page, demo/simulation mode. |

## Run it

Requires Node 22+.

```bash
npm install
npm run demo        # seeded demo workspace with simulated mailboxes → http://localhost:8080
```

Sign in with `demo@cold.local` / `cold-demo-2026`. The demo has three sending Microsoft domains, a Google domain, warmed and warming reserve domains, a cleaned list, a live campaign, 30 days of history, and **one domain that is burning**. Open **Diagnoses** to run the control test and rotate it out.

Development with hot reload (API on :8080, UI on :5173):

```bash
npm run dev
```

Without `DATABASE_URL`, Cold uses an embedded PGlite database in `./data`. Set `DATABASE_URL` to use PostgreSQL. Migrations run automatically on boot.

```bash
npm test            # core unit tests + full end-to-end API test (setup → send → diagnose → rotate)
npm run typecheck
npm run build       # web + server bundle in apps/server/dist
```

## Connect real infrastructure

1. **Settings → General**: confirm your protected primary domain and set your postal address (CAN-SPAM).
2. **Settings → Integrations → Add tenant**:
   - **Microsoft 365** (Hypertide or direct): create an Entra app registration with the Microsoft Graph application permissions `Mail.Send` and `Mail.ReadWrite`, grant admin consent, and paste the tenant ID, client ID and client secret.
   - **Google Workspace**: create a service account, enable the Gmail API, and authorize its client ID for `https://www.googleapis.com/auth/gmail.modify` under domain-wide delegation. Paste the JSON key.
3. **Integrations**: add a Cloudflare API token (Zone → Zone: Read and Zone → DNS: Edit, all zones) and a validation key (MillionVerifier is the cheapest per check). Optionally add a Slack webhook and a Spamhaus DQS key.
4. **Domains → Add domains → Load my Cloudflare domains**: tick the sending domains (your primary domain is shown as protected and can't be picked), choose the provider and set (active or reserve), then add the personas.
5. **Domains → Write DNS via Cloudflare** writes SPF, DMARC and MX for every new domain and checks them. Paste each domain's DKIM value from Google Admin or Microsoft Defender on its page, pass the header test, then **Start warmup**. Domains in the active set start sending automatically once warm.
6. **Lists → Upload**, then **Campaigns → New**, write the copy, enroll the list and launch.
7. Mark two connected inboxes (one Gmail, one Outlook) as **seeds** so diagnoses run automatically.

> **Access you need from your mailbox vendor.** Cold talks to mailboxes through the providers' admin APIs: an Entra app with application permissions in each Microsoft 365 tenant, or a Google service account with domain-wide delegation. Both need **admin access to the tenant**. Ask Hypertide (or your vendor) whether you get tenant admin. If they only hand out mailbox passwords, Cold needs a per-mailbox sign-in flow, which isn't built yet.

> The Graph, Gmail, MillionVerifier, ZeroBounce, Cloudflare, RDAP and Spamhaus adapters are written against those providers' public APIs. They are covered by the simulated end-to-end test but **have not yet been exercised against live tenants**. Run a small pilot (one domain, a few seed addresses) before scaling. Hypertide has no public API for Recovery Pool, Relay or Layover that this project could verify, so Cold tracks those states itself and raises "vendor task" reminders for you to mirror them in Hypertide.

## Mailbox costs: Google Workspace vs Microsoft 365

Researched November 2026 (the in-app **Planner** has these as presets, with sources, and you can edit every number).

| Option | Per inbox / month | Sends per inbox / day | Per daily send | 1,000 emails/day incl. warmed reserve |
|---|---|---|---|---|
| Bulk “Azure” Microsoft inboxes via reseller (e.g. Hypertide), reserves free in Recovery Pool | ~$1 reported ($0.50 in older reports) | 3 | $0.33 | **~$376/mo** (700 inboxes, 28 domains) |
| Google inboxes via cold-email reseller | ~$3 ($2.50–3.50) | 15 | $0.20 | ~$456/mo (138 inboxes, 46 domains) |
| Google Workspace Business Starter, annual | $7 | 15 | $0.47 | ~$1,008/mo |
| Google Workspace Business Starter, monthly | $8.40 | 15 | $0.56 | ~$1,201/mo |
| Microsoft per-inbox Outlook resellers | ~$3 ($2.25–4.50) | 3 | $1.00 | ~$2,113/mo |
| Exchange Online Plan 1, bought from Microsoft | ~$4 | 3 | $1.33 | ~$2,813/mo |
| Microsoft 365 Business Basic, bought from Microsoft | $7 (from July 1, 2026) | 3 | $2.33 | ~$4,913/mo |

What this means:

- **The “Azure is 5–6× cheaper” rule is about the price per inbox, and only through bulk resellers.** A bulk Azure inbox (~$1) is ~7× cheaper than a Google Workspace seat, but the playbook lets it send 3 emails a day instead of 15, so per email it is only ~1.4× cheaper. The rest of the gap comes from free reserve inboxes and needing fewer domains (28 vs 46 here). At ~$0.50 per inbox the overall saving is ~5×.
- **Buying Microsoft licenses directly from Microsoft is the most expensive way to send cold email**: 3–5× Google per email.
- **Google through a reseller is close to bulk Azure** (~$456 vs ~$376 at 1,000/day), with far fewer inboxes to manage. Anything priced per inbox (warmup tools, seats) is multiplied ~5× on Microsoft.
- Reseller prices are third-party reports. Confirm current pricing, and how the inboxes are licensed, with the vendor before buying.

Sources: [Google Workspace pricing (dupple)](https://dupple.com/learn/google-workspace-pricing), [Google Workspace pricing (dragapp)](https://www.dragapp.com/blog/google-workspace-pricing/), [Microsoft 365 pricing updates (Microsoft)](https://www.microsoft.com/en-us/licensing/news/2026-m365-packaging-pricing-updates), [Exchange Online plans (o365hq)](https://o365hq.com/md/blog/exchange-online-plan-1-vs-plan-2-vs-kiosk-vs-business-basic-mailbox-licensing), [Hypertide review (outreach2day)](https://outreach2day.com/reviews/hypertide), [Hypertide review (aerosend)](https://www.aerosend.io/review/hypertide/), [Hypertide Google](https://www.hypertide.io/google), [InboxKit comparison](https://www.inboxkit.com/learn/cold-email-infrastructure-comparison-2026), [Cold email infrastructure cost (maildeck)](https://maildeck.co/blog/cold-email-infrastructure-cost-2026/).

## Deploy to Cloudflare (cold.cleargraph.co)

Cold runs as one container on **Cloudflare Containers**, behind a small Worker (`infra/cloudflare`) served at **https://cold.cleargraph.co**. The Worker routes every request to a single container instance and pings it every 5 minutes, so the background jobs (sender, warmup, inbox sync, health, rotation timers) keep running. Data lives in an external **PostgreSQL** database, because container disks are wiped on restart.

The GitHub workflow does the whole deploy, so you don't need Docker or a terminal:

1. **Database:** create a Postgres database (e.g. a [Neon](https://neon.com/pricing) project) and copy its connection string (`postgres://…?sslmode=require`).
2. **Cloudflare API token:** start from the *Edit Cloudflare Workers* template and add *Account → Containers → Edit*. The `cleargraph.co` zone must be in the same account. Cloudflare creates the `cold.cleargraph.co` DNS record and certificate on deploy.
3. **GitHub → Settings → Secrets and variables → Actions:** add these secrets:
   - `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
   - `DATABASE_URL`
   - `APP_SECRET`: `openssl rand -hex 32`. Keep a copy: it decrypts stored credentials.
   - `SETUP_TOKEN`: any long random string.
4. **Actions → Deploy to Cloudflare → Run workflow.** It checks the secrets, builds the image, uploads the secrets with the version, deploys and smoke-tests `/healthz`. Set the repository variable `CLOUDFLARE_DEPLOY=true` to deploy on every push to `main`.
5. **Open https://cold.cleargraph.co.** Enter the setup token, create the owner account, and protect `cleargraph.co` as your primary domain. Only someone with the token can claim an empty instance.

Optional: put [Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/) in front of `cold.cleargraph.co` for SSO. It's free for up to 50 users.

From a terminal instead, with Docker running: `cd infra/cloudflare && npm install`, `npx wrangler secret put` for `DATABASE_URL`, `APP_SECRET` and `SETUP_TOKEN`, then `npx wrangler deploy`.

**Rough monthly cost**, from Cloudflare's published usage rates:

| Item | ≈ / month |
|---|---|
| Workers Paid plan | $5 |
| One `basic` container (1/4 vCPU, 1 GiB) always on: memory ~$6.35, disk ~$0.70, CPU billed on active use (light) | $7–9 |
| PostgreSQL: Neon Free (100 compute-hours/month; Cold polls every 30s so it may run out before month end) or Neon Launch (~$0.106 per compute-hour) | $0–20 |
| **Total platform** | **≈ $12–35** |

Keep `max_instances` at 1: the scheduler runs inside the container and must run once.

> I couldn't run a real deploy from this environment (no Docker daemon, no Cloudflare account). `wrangler deploy --dry-run` validates the config, custom domain and Worker bundle. Container settings follow the `@cloudflare/containers` README and Wrangler's config schema. Check the first deploy's logs (`npx wrangler tail`).

**Other hosts.** The same image runs anywhere that runs Docker plus Postgres: `docker compose up` locally, or Azure Container Apps (`infra/azure/main.bicep`, manual workflow `deploy-azure.yml`).

## Layout

```
packages/core      domain logic + unit tests (shared by server and browser)
apps/server        Fastify API, Drizzle schema/migrations, adapters, services, jobs, demo seed, e2e test
apps/web           React + Vite + Tailwind UI
infra/cloudflare   Worker + wrangler config for Cloudflare Containers (default host)
infra/azure        Bicep for Azure Container Apps + PostgreSQL (alternative host)
SPEC.md            product specification
```
