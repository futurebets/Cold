# Cold

Cold is a cold email deliverability platform. It runs the whole sending infrastructure lifecycle and enforces a 14-rule deliverability playbook as **guardrails, not advice**:

> protect the primary domain → provision lookalike domains on Google Workspace or Microsoft 365 → authenticate → warm → enforce caps → clean lists → lint copy → stagger sends → measure health against baselines → diagnose copy vs. infrastructure → rotate in warmed replacements without stopping or losing a reply.

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
3. **Integrations**: add a validation key (MillionVerifier is the cheapest per check), and optionally a Cloudflare token (automatic DNS), a Slack webhook and a Spamhaus DQS key.
4. **Domains → Add domains**: pick the provider and set (active or reserve), then add the personas.
5. On each domain: write the DNS records, check them, then pass the header test and start warmup (or attest that warmup already started elsewhere). Domains in the active set start sending automatically once warm.
6. **Lists → Upload**, then **Campaigns → New**, write the copy, enroll the list and launch.
7. Mark two connected inboxes (one Gmail, one Outlook) as **seeds** so diagnoses run automatically.

> The Graph, Gmail, MillionVerifier, ZeroBounce, Cloudflare, RDAP and Spamhaus adapters are written against those providers' public APIs. They are covered by the simulated end-to-end test but **have not yet been exercised against live tenants**. Run a small pilot (one domain, a few seed addresses) before scaling. Hypertide has no public API for Recovery Pool, Relay or Layover that this project could verify, so Cold tracks those states itself and raises "vendor task" reminders for you to mirror them in Hypertide.

## Deploy to Azure

One container serves the API, web app and background jobs. It runs on **Azure Container Apps** with **Azure Database for PostgreSQL Flexible Server (Burstable B1ms)**.

```bash
az group create -n cold-rg -l eastus
az deployment group create -g cold-rg -f infra/azure/main.bicep -p \
  image=ghcr.io/<owner>/cold:latest \
  appSecret=$(openssl rand -hex 32) \
  dbAdminPassword='<strong password>' \
  registryServer=ghcr.io registryUsername=<github user> registryPassword=<PAT with read:packages>
```

After the first deploy, `.github/workflows/deploy.yml` builds and pushes the image to GHCR and rolls the app on every push to `main`. The workflow file lists the one-time setup it needs (OIDC federated credential, secrets and variables).

**Rough monthly cost at list prices** (check the Azure pricing calculator for your region):

| Resource | Size | ≈ / month |
|---|---|---|
| Container Apps | 1 replica, 0.5 vCPU / 1 GiB, always on | $15–35 |
| PostgreSQL Flexible | B1ms + 32 GB | $15–20 |
| Log Analytics | light usage | $0–5 |
| **Total platform** | | **≈ $30–60** |

Mailboxes, domains and validation credits are separate. Use **Planner** in the app to compare Google vs Microsoft with your own vendor quotes. The default cost-saving setup is Microsoft mailboxes, reserve domains in Hypertide's Recovery Pool, free Cloudflare DNS, free MX/SEG checks before paid validation, and validation caching.

Keep the app at **exactly one replica**: the scheduler runs in-process. To scale the web tier, run extra replicas with `JOBS_ENABLED=false`.

## Layout

```
packages/core      domain logic + unit tests (shared by server and browser)
apps/server        Fastify API, Drizzle schema/migrations, adapters, services, jobs, demo seed, e2e test
apps/web           React + Vite + Tailwind UI
infra/azure        Bicep for Container Apps + PostgreSQL
SPEC.md            product specification
```
