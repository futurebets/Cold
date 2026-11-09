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

## Deploy to Cloudflare

Cold runs as one container on **Cloudflare Containers**, behind a small Worker (`infra/cloudflare`). The Worker routes every request to a single container instance and pings it every 5 minutes, so the background jobs (sender, inbox sync, health, rotation timers) keep running. Data lives in an external **PostgreSQL** database, because container disks are wiped on restart.

1. Create a Postgres database (e.g. [Neon](https://neon.com/pricing)) and copy its connection string (`...?sslmode=require`).
2. Deploy (needs a Workers Paid plan and Docker running locally):

```bash
cd infra/cloudflare
npm install
npx wrangler secret put DATABASE_URL     # paste the Postgres URL
npx wrangler secret put APP_SECRET       # paste: openssl rand -hex 32  (keep it safe: it decrypts stored credentials)
npx wrangler deploy
```

After that, `.github/workflows/deploy-cloudflare.yml` deploys on every push to `main`. Set the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and the variable `CLOUDFLARE_DEPLOY=true`. GitHub's runners have Docker, so you don't need it locally after the first deploy.

**Rough monthly cost**, from Cloudflare's published usage rates:

| Item | ≈ / month |
|---|---|
| Workers Paid plan | $5 |
| One `basic` container (1/4 vCPU, 1 GiB) always on: memory ~$6.35, disk ~$0.70, CPU billed on active use (light) | $7–9 |
| PostgreSQL: Neon Free (100 compute-hours/month; Cold polls every 30s so it may run out before month end) or Neon Launch (~$0.106 per compute-hour) | $0–20 |
| **Total platform** | **≈ $12–35** |

Keep `max_instances` at 1: the scheduler runs inside the container and must run once.

> I couldn't run a real deploy from this environment (no Docker daemon, no Cloudflare account). `wrangler deploy --dry-run` validates the config and bundles the Worker. Container settings follow the `@cloudflare/containers` README and Wrangler's config schema. Check the first deploy's logs (`npx wrangler tail`).

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
