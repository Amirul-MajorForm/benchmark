import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "pg";
import { closePool, getPool, migrate } from "../lib/db";
import { runSync } from "../lib/sync";

// Own database so this file can run alongside the other database tests.
const base = process.env.TEST_PG_URL ?? "postgres://postgres@127.0.0.1:5432";
process.env.DATABASE_URL = `${base}/benchmarks_sync_test`;

const OATSIDE = "764971328270854";
const BLUESG = "1696096351654353"; // disabled in Two Minutes

/** Mock Two Minutes: refuses any request naming BlueSG, like the live API does once an account is disabled. */
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    res.setHeader("content-type", "application/json");
    if (body.accounts?.includes(`fads_act_${BLUESG}`)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ success: false, error: { message: `These accounts are not enabled for this team and can't be queried: act_${BLUESG}.` } }));
    }
    const isMain = body.dimensions.includes("fads_account_currency") && body.dimensions.includes("fads_year_month");
    const inQ2 = body.startDate === "2025-04-01";
    const data = isMain && inQ2
      ? [{ fads_account_id: OATSIDE, fads_campaign_objective: "OUTCOME_TRAFFIC", fads_optimization_goal: "LANDING_PAGE_VIEWS",
           fads_year_month: "2025-May", fads_account_currency: "SGD", fads_spend: 100, fads_impressions: 1000, fads_clicks: 20,
           fads_link_clicks: 10, fads_website_fb_landing_page_views: 8 }]
      : [];
    res.end(JSON.stringify({ success: true, data }));
  });
});

before(async () => {
  const admin = new Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  const { rows } = await admin.query("select 1 from pg_database where datname = 'benchmarks_sync_test'");
  if (!rows.length) await admin.query("create database benchmarks_sync_test");
  await admin.end();
  await migrate();
  const pool = getPool();
  await pool.query("truncate fact_monthly, sync_chunks, sync_runs, app_settings");
  await pool.query("update accounts set enabled = (account_id in ($1, $2))", [OATSIDE, BLUESG]);
  // BlueSG history saved by an earlier sync, inside the chunk about to be re-pulled.
  await pool.query(
    `insert into fact_monthly (platform, account_id, objective, goal, month, spend_sgd, impressions)
     values ('meta', $1, 'OUTCOME_APP_PROMOTION', 'APP_INSTALLS', '2025-05-01', 500, 9000)`,
    [BLUESG],
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});

after(async () => {
  server.close();
  await closePool();
});

test("a disabled account is skipped, its saved history kept, and the run notes it", async () => {
  const { port } = server.address() as AddressInfo;
  const result = await runSync({
    today: "2025-06-30",
    full: true,
    log: () => {},
    cfg: {
      apiKey: "k", teamId: "team-1", baseUrl: `http://127.0.0.1:${port}/v1`, queryPath: "/teams/{teamId}/query",
      fieldPrefix: "", timeoutMs: 5000, retries: 0, backoffMs: 1, minIntervalMs: 0, rateLimitWaitsMs: [1],
    },
  });
  assert.equal(result.status, "success", result.error);
  assert.match(result.note ?? "", new RegExp(`act_${BLUESG}`));

  const { rows } = await getPool().query("select account_id, spend_sgd::float8 as spend, landing_page_views::float8 as lpv from fact_monthly order by account_id");
  assert.deepEqual(rows, [
    { account_id: BLUESG, spend: 500, lpv: null }, // untouched
    { account_id: OATSIDE, spend: 100, lpv: 8 },
  ]);
  const { rows: runs } = await getPool().query("select status, error from sync_runs order by id desc limit 1");
  assert.equal(runs[0].status, "success");
  assert.match(runs[0].error, /not enabled in Two Minutes/);
});
