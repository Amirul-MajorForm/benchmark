# Media Benchmarks by MajorForm

A web app that answers questions like *"What was CPM for Reach campaigns on Meta in Q2 2025?"* across every MajorForm client, market and platform.

A nightly job copies monthly Meta data from Two Minute Reports into Postgres. The app only reads Postgres, so pages render in about 0.2s, compared with the 25 to 60 seconds each Two Minutes call takes.

```
Railway cron (03:00 SGT) ── npm run sync ──► Two Minute Reports REST API
                                   │          (half-year chunks, retries)
                                   ▼
                             Railway Postgres  ◄── Next.js app (read-only)
```

---

## Running it

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL at minimum
npm run migrate               # tables + Meta account mapping seed
npm run sync                  # needs TMR_API_KEY; first run backfills from 2025-01-01
npm run dev                   # http://localhost:3000
```

With no API key, `npm run fixture:load` loads recorded Q2 2025 Two Minutes data through the real sync code, so you can work on the UI.

| Script | What it does |
|---|---|
| `npm run sync` | Backfill any half-year not yet synced, and re-pull the half-years holding the last 3 months |
| `npm run sync -- --full` | Re-pull everything from 2025-01-01 (e.g. after changing an account's Brand/CPAS type) |
| `npm run tmr:probe` | One tiny live query to confirm the REST endpoint and response shape (see below) |
| `npm test` | Unit tests + brief §9 acceptance tests (needs a local Postgres `benchmarks_test` database) |
| `ACCEPTANCE_LIVE=1 DATABASE_URL=... npm run test:acceptance` | Acceptance tests against a real synced DB, including the all-time spend check |

## Two Minutes endpoint

The Two Minutes REST docs couldn't be reached from the build environment, so the client finds the Run query endpoint itself. It tries `TMR_QUERY_PATH` first, then the server's OpenAPI spec if it publishes one, then a list of likely paths. A wrong path returns a fast 404, so this adds a second or two to the first call. The sync log prints the path it found; set `TMR_QUERY_PATH` to it to skip the check. If nothing matches, the error lists every path tried with its HTTP status.

The endpoint is `POST /teams/{teamId}/data/run-query` (found on the live API; the sync saves it in `app_settings`). Its body follows the format Two Minutes uses for dashboard widget queries: `accounts` and every field id carry the connector prefix (`fads_act_764971328270854`, `fads_spend`), and Meta options such as `includeAllItems` go in `fadsOptions`. If the API rejects prefixed field ids, the client retries once with raw ids and remembers that. `TMR_FIELD_PREFIX=none` forces raw ids. `npm run tmr:probe` runs one tiny query (OATSIDE, June 2025) to check the key, the endpoint and the response shape. The key must be an **API** key with scope `data:read`; an MCP key will not work.

## Deploying on Railway

One repo, two services, one Postgres.

1. **Postgres:** add the Railway Postgres plugin.
2. **Web service:** deploy this repo. `railway.json` sets `npm start` (runs migrations, then `next start`) and a healthcheck on `/api/health`. Set the env vars below, with `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
3. **Cron service:** add a second service from the same repo. Under *Settings → Config-as-code*, set the file to `railway.cron.json`. That runs `npm run sync` on `0 19 * * *` (19:00 UTC = 03:00 SGT). Give it `DATABASE_URL` and `TMR_API_KEY`.

| Variable | Notes |
|---|---|
| `TMR_API_KEY` | Two Minutes → Settings → API keys, intended use **API**, scope `data:read` |
| `TMR_TEAM_ID` | `019d0ca3-ce95-7387-a650-5e055605107a` |
| `TMR_QUERY_PATH` | Optional; the sync finds it, logs it and saves it (see above). `TMR_API_BASE` and `TMR_FIELD_PREFIX` normally stay unset |
| `DATABASE_URL` | Railway Postgres (`PGSSLMODE=require` if connecting over the public proxy) |
| `BASIC_AUTH_PASSWORD` | Optional. When set, the whole app asks for one shared password (username `majorform`, or `BASIC_AUTH_USER`). Empty means open access |

**Access.** There is no login: anyone with the URL can see the page and press **Sync now** (a second press while a sync runs is refused). To lock it down, set `BASIC_AUTH_PASSWORD`; `/api/health` stays open for Railway's healthcheck.

## How the data is built

**Queries** (`lib/transform.ts`). These are the brief's 3a (spend, impressions, clicks, link clicks in SGD) and 3b (purchases in account currency, `campaign_objective equals OUTCOME_SALES`), both with dimensions `account_id, campaign_objective, optimization_goal, year_month` and `includeAllItems`. Response headers come back as display labels ("Facebook Ads Amount spent"), so columns are mapped by position to the requested fields. Empty cells become null, and `2025-Feb` becomes `2025-02-01`.

**Chunking: why half-years matter.** Purchase counts for a month depend on the query's start date. Pulled from Apr 1, April 2025 shows 1,155 CPAS purchases for OATSIDE PH; pulled from Jan 1, it shows 1,167. The acceptance numbers were computed from half-year pulls, so:

- the purchases query always runs over a whole half-year (Jan–Jun or Jul–Dec), even when only recent months need refreshing.
- the main query (spend and delivery, which don't depend on attribution) runs per quarter, which keeps each call under the timeout. A half-year main pull timed out at 60s while testing.
- each sync re-pulls every half-year that overlaps the current and previous 2 months, so Meta restatements land. Closed half-years are pulled once (tracked in `sync_chunks`).
- each call is retried 3 times with exponential backoff (2s, 4s, 8s) on timeouts, network drops, 429 and 5xx. If a half-year purchases pull still fails, the sync falls back to quarters and logs a warning.

**Writes.** Each chunk replaces its months in one transaction. If Two Minutes returns nothing for a chunk that has data, the sync fails and keeps the old rows. SGD spend is stored to the cent per row (after conversion). Every run is logged in `sync_runs`. A failed run leaves the previous data in place, and the error shows on the page.

**Spend to SGD** (`lib/fx.ts`). The Two Minutes REST API returns spend in each ad account's own currency and ignored every way of asking for SGD (`currencyCode`, per-metric `metricConfigs`, `dataOptions.currency`). So the spend query also returns `account_currency`, a light extra query returns each account's daily local spend, and each account-month is converted at its spend-weighted rate: Σ(daily spend × that day's rate) ÷ Σ daily spend. Daily SGD rates come from the free [currency-api](https://github.com/fawazahmed0/exchange-api) (jsDelivr, with a Cloudflare Pages mirror) and are cached in `fx_daily`, so a finished month is fetched once. Checked against the rates Two Minutes applied in the prototype: PHP June 2025 is within 0.03% spend-weighted (a plain monthly average was 1.4% off). If the daily query fails, the month's average rate is used and the sync logs a warning. The sync also refuses to save a chunk where a known MYR/PHP/IDR account's SGD spend equals its local spend. Each account's currency is recorded in `accounts.currency`.

**Purchase value currency** (`applyCurrencyConversion`). `purchase_value_sgd = purchase_value_native × rate`, where rate is the account's Σ SGD spend ÷ Σ local spend over its Sales rows that month. Months with no spend fall back to the account's all-time rate. SGD-billed accounts come out at 1.

## Ask (natural-language questions)

The **Ask** bar under the header takes plain-English questions ("what's the QoQ trend?", "which market has the lowest Reach CPM this year?"). `lib/ask.ts` sends the question to Claude (`claude-opus-5-5`, medium effort, server-side refusal fallbacks on) with a short description of the data and the dashboard view the user is on. Claude gets **no raw data**: it calls a `query_benchmarks` tool (`lib/query.ts`), which runs the dashboard's own filtering and metric code, grouped by month, quarter, year, market, client, objective, goal, account or account type. Every figure in an answer is therefore computed exactly like the page. A second tool, `show_on_dashboard`, lets Claude offer an "Open this view" link.

Set `ANTHROPIC_API_KEY` on the web service to turn it on. Each question costs a few cents, typically 2 to 4 tool calls. Because the app has no login, `/api/ask` allows 30 questions per visitor IP per hour and 500 characters per question.

## Metrics

All ratios come from summed components over the filtered rows (`lib/metrics.ts`), never from averaged ratios:

| Metric | Formula |
|---|---|
| CPM | Σ spend ÷ Σ impressions × 1000 |
| CPC (link) | Σ spend ÷ Σ link clicks |
| CTR (link) | Σ link clicks ÷ Σ impressions |
| CPA | Σ tracked spend ÷ Σ purchases |
| ROAS | Σ purchase value (SGD) ÷ Σ tracked spend |

*Tracked spend* is Sales-objective spend from accounts that have ever reported a purchase, so accounts with no purchase tracking (e.g. Yoga Movement's Sales campaigns) don't drag CPA and ROAS down. CPA and ROAS show blank when there are no purchases. Purchases come from `collab_action_omni_purchase` / `collab_ads_value_omni_purchase` for CPAS accounts and `all_purchases` / `purchase_conversions_all` for Brand accounts.

## Acceptance tests (brief §9)

`tests/acceptance.test.ts` loads real Two Minutes responses for Q2 2025 (recorded 25 Oct 2026, in `tests/fixtures/`) through the real sync code into Postgres. It then checks every Q2 2025 row of the brief to the cent: Reach CPM S$0.394 on S$16,549.90, CPAS CPA S$4.84 / ROAS 4.39x on 4,988 purchases, Brand CPA S$22.70 / ROAS 2.47x, and the rest. The all-time spend check (S$733,149.58 to 24 Oct 2026) needs a full live sync, so it runs with `ACCEPTANCE_LIVE=1`. The recorded responses were converted to SGD by Two Minutes, so these tests check the metric logic to the cent. Live data is converted by our own rates (above) and lands within a fraction of a percent of those figures.

## Code map

```
app/page.tsx                 the one page: filters, takeaway, tiles, chart, tables, footnote
app/api/benchmarks           GET aggregated view for any filter set (same query string as the page)
app/api/sync                 POST "Sync now" (runs in the background), GET sync status
app/api/health               Railway healthcheck
proxy.ts                     optional shared password (BASIC_AUTH_PASSWORD)
lib/tmr.ts                   Two Minutes REST client: request body, retries, response parsing
lib/transform.ts             queries 3a/3b, merge, purchases by account type, currency conversion
lib/sync.ts                  chunk planning, pulls, transactional replace, sync_runs logging
lib/metrics.ts               totals and ratio formulas
lib/filters.ts               URL filters and periods (client-safe)
lib/benchmarks.ts            loads facts (cached until the next sync) and builds the page's view model
db/schema.sql                tables (idempotent)
db/seed-accounts.sql         Meta account → client / market / Brand-or-CPAS mapping
```

## Adding TikTok and Google Ads later

The `platform` column, Platform filter and labels already exist. Adding one means: seed its accounts with `platform = 'tiktok'` (connector `ttads`) or `'google'` (`gadw`), add its query definitions and field mapping beside the Meta ones in `lib/transform.ts`, and loop over platforms in `lib/sync.ts`. An admin page to edit the account mapping is also still to build; until then, edit the `accounts` table directly. A change to `account_type` needs `npm run sync -- --full` to re-derive purchases.

## Open question

Is the main **OATSIDE** account (`764971328270854`, SGD-billed) Singapore? It is seeded as market SG.
