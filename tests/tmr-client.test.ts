import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { buildBody, extractTable, runQuery, type TmrConfig, TmrError } from "../lib/tmr";
import { mainQuery, purchasesQuery } from "../lib/transform";

/** Mock Two Minutes: only `route` exists; everything else 404s like the real API. */
function mockTmr(route: string, opts: { spec?: boolean; status?: number; rateLimitFirst?: number; rejectPrefixed?: boolean } = {}) {
  const hits: string[] = [];
  const bodies: any[] = [];
  let limited = 0;
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (limited < (opts.rateLimitFirst ?? 0)) {
      limited++;
      res.writeHead(429, { "content-type": "application/json" });
      return res.end(JSON.stringify({ title: "Error 1015: You are being rate limited", status: 429 }));
    }
    if (opts.spec && req.method === "GET" && req.url === "/v1/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ paths: { [`/v1${route.replace("{teamId}", "{team_id}")}`]: { post: { summary: "Run query" } } } }));
    }
    if (req.method === "POST" && req.url === `/v1${route.replace("{teamId}", "team-1")}`) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        bodies.push(body);
        if (!Array.isArray(body.accounts)) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: { code: "BAD_REQUEST", message: 'Validation error: Expected array, received undefined at "accounts"' } }));
        }
        if (opts.rejectPrefixed && body.metrics.some((m: string) => m.startsWith("fads_"))) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: { code: "BAD_REQUEST", message: `Unknown metric ${body.metrics[0]}` } }));
        }
        res.writeHead(opts.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { headers: body.dimensions.concat(body.metrics), rows: [["act_1", "OUTCOME_SALES", "REACH", "2025-Jun", 1, 2, 3, 4]] } }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: `Cannot ${req.method} ${req.url}` } }));
  });
  return { server, hits, bodies };
}

const listen = (server: Server) => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)));

const cfg = (baseUrl: string): TmrConfig => ({
  apiKey: "k", teamId: "team-1", baseUrl, queryPath: "/teams/{teamId}/query", fieldPrefix: "", timeoutMs: 5000, retries: 0, backoffMs: 1,
  minIntervalMs: 0, rateLimitWaitsMs: [5, 5, 5],
});
const req = { connectorId: "fads", accountIds: ["act_1", "act_2"], currencyCode: "SGD", title: "t", query: mainQuery("2025-06-01", "2025-06-30") };
const quiet = () => {};

describe("TMR endpoint discovery", () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));

  test("falls back to a candidate path when the configured one 404s", async () => {
    const { server, hits, bodies } = mockTmr("/data/query");
    servers.push(server);
    const table = await runQuery(req, cfg(await listen(server)), quiet);
    assert.equal(table.rows.length, 1);
    assert.deepEqual(table.rows[0], ["act_1", "OUTCOME_SALES", "REACH", "2025-Jun", 1, 2, 3, 4]);
    assert.deepEqual(bodies.at(-1).accounts, ["fads_act_1", "fads_act_2"]);
    assert.ok(hits.includes("POST /v1/teams/team-1/query"));
    assert.equal(hits.filter((h) => h === "POST /v1/data/query").length, 2); // endpoint check + real query
  });

  test("uses the OpenAPI spec when the server publishes one", async () => {
    const { server, hits } = mockTmr("/teams/{teamId}/insights/run", { spec: true });
    servers.push(server);
    const table = await runQuery(req, cfg(await listen(server)), quiet);
    assert.equal(table.rows.length, 1);
    assert.ok(hits.includes("POST /v1/teams/team-1/insights/run"));
  });

  test("waits out 429s and never mistakes one for the endpoint", async () => {
    const { server, hits } = mockTmr("/data/query", { rateLimitFirst: 3 });
    servers.push(server);
    const table = await runQuery(req, cfg(await listen(server)), quiet);
    assert.equal(table.rows.length, 1);
    // the configured path was retried after the 429s and then 404'd; discovery moved on to /data/query
    assert.ok(hits.filter((h) => h === "POST /v1/teams/team-1/query").length >= 2);
    assert.ok(hits.includes("POST /v1/data/query"));
  });

  test("gives up with a short message when the rate limit does not lift", async () => {
    const { server } = mockTmr("/data/query", { rateLimitFirst: 100 });
    servers.push(server);
    await assert.rejects(runQuery(req, cfg(await listen(server)), quiet), /rate-limiting this server/);
  });

  test("retries with raw field ids when prefixed ones are rejected", async () => {
    const { server, bodies } = mockTmr("/teams/{teamId}/query", { rejectPrefixed: true });
    servers.push(server);
    const table = await runQuery(req, cfg(await listen(server)), quiet);
    assert.equal(table.rows.length, 1);
    assert.equal(bodies.at(-1).metrics[0], "spend");
    assert.deepEqual(bodies.at(-1).accounts, ["fads_act_1", "fads_act_2"]);
  });

  test("reports every path tried when nothing matches", async () => {
    const { server } = mockTmr("/nowhere/at/all");
    servers.push(server);
    await assert.rejects(runQuery(req, cfg(await listen(server)), quiet), (err: TmrError) => {
      assert.match(err.message, /Could not find the Two Minutes Run query endpoint/);
      assert.match(err.message, /\/data\/query 404/);
      return true;
    });
  });
});

describe("REST request body", () => {
  const c = { teamId: "team-1", fieldPrefix: "" };

  test("accounts and fields carry the connector prefix, like dashboard widget queries", () => {
    const body = buildBody(c, { connectorId: "fads", accountIds: ["act_764971328270854"], currencyCode: "SGD", title: "t", query: mainQuery("2025-01-01", "2025-03-31") });
    assert.deepEqual(body.accounts, ["fads_act_764971328270854"]);
    assert.deepEqual(body.dimensions, ["fads_account_id", "fads_campaign_objective", "fads_optimization_goal", "fads_year_month"]);
    assert.deepEqual(body.metrics, ["fads_spend", "fads_impressions", "fads_clicks", "fads_link_clicks"]);
    assert.deepEqual(body.dateRange, { startDate: "2025-01-01", endDate: "2025-03-31" });
    assert.deepEqual((body as any).dataOptions, { currency: "SGD" });
    assert.equal(body.currencyCode, "SGD");
    assert.deepEqual((body as any).metricConfigs, { fads_spend: { unit: { type: "currency", subtype: "SGD" } } });
    assert.deepEqual((body as any).fadsOptions, { includeAllItems: true, currencyCode: "SGD" });
  });

  test("purchases query: no API filter (Sales rows picked in mergeChunk), no currency", () => {
    const body = buildBody(c, { connectorId: "fads", accountIds: ["act_1"], title: "t", query: purchasesQuery("2025-01-01", "2025-06-30") });
    assert.deepEqual(body.filters, []);
    assert.equal(body.currencyCode, undefined);
    assert.equal((body as any).metricConfigs, undefined);
    assert.equal((body as any).dataOptions, undefined);
  });

  test("filters, when used, carry fieldId", () => {
    const q = { ...mainQuery("2025-01-01", "2025-01-31"), filters: [{ filterField: "campaign_objective", operator: "equals" as const, expression: "OUTCOME_SALES" }] };
    const body = buildBody(c, { connectorId: "fads", accountIds: ["act_1"], title: "t", query: q });
    assert.equal(body.filters[0].fieldId, "fads_campaign_objective");
    assert.equal(body.filters[0].value, "OUTCOME_SALES");
  });

  test("TMR_FIELD_PREFIX=none sends raw field ids (accounts stay prefixed)", () => {
    const body = buildBody({ teamId: "t", fieldPrefix: "none" }, { connectorId: "fads", accountIds: ["act_1"], title: "t", query: mainQuery("2025-01-01", "2025-01-31") });
    assert.equal(body.metrics[0], "spend");
    assert.deepEqual(body.accounts, ["fads_act_1"]);
  });
});

describe("response shapes", () => {
  const q = { connectorId: "fads", query: { dateRange: { startDate: "x", endDate: "y" }, dimensions: ["account_id", "year_month"], metrics: ["clicks", "link_clicks"] } };

  test("rows as objects keyed by prefixed ids (clicks is not confused with link_clicks)", () => {
    const t = extractTable({ success: true, data: [{ fads_link_clicks: 5, fads_clicks: 9, fads_year_month: "2025-Jun", fads_account_id: "1" }] }, q);
    assert.deepEqual(t.rows, [["1", "2025-Jun", 9, 5]]);
  });

  test("object rows omit empty fields: missing metrics are null, missing dimensions are an error", () => {
    const t = extractTable({ success: true, data: [
      { fads_account_id: "1", fads_year_month: "2025-Jun", fads_clicks: 9 },
      { fads_account_id: "2", fads_year_month: "2025-Jun", fads_clicks: 4, fads_link_clicks: 2 },
    ] }, q);
    assert.deepEqual(t.rows, [["1", "2025-Jun", 9, null], ["2", "2025-Jun", 4, 2]]);
    const noLink = extractTable({ data: [{ fads_account_id: "1", fads_year_month: "2025-Jun", fads_clicks: 9 }] }, q);
    assert.deepEqual(noLink.rows, [["1", "2025-Jun", 9, null]]);
    assert.throws(() => extractTable({ data: [{ fads_account_id: "1", fads_clicks: 9 }] }, q), /missing dimension fads?_?year_month|missing dimension year_month/);
  });

  test("header ids in a different order are reordered", () => {
    const t = extractTable({ data: { headers: ["fads_clicks", "fads_account_id", "fads_link_clicks", "fads_year_month"], rows: [[9, "1", 5, "2025-Jun"]] } }, q);
    assert.deepEqual(t.rows, [["1", "2025-Jun", 9, 5]]);
  });

  test("label headers map by position; API errors surface", () => {
    const t = extractTable({ data: { headers: ["A", "B", "C", "D"], rows: [["1", "2025-Jun", 9, 5]] } }, q);
    assert.deepEqual(t.rows, [["1", "2025-Jun", 9, 5]]);
    assert.throws(() => extractTable({ success: false, error: { message: "Unknown metric fads_spend" } }, q), /Unknown metric/);
    assert.deepEqual(extractTable({ success: true, data: [] }, q).rows, []);
  });
});
