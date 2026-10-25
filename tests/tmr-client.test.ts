import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { runQuery, type TmrConfig, TmrError } from "../lib/tmr";
import { mainQuery } from "../lib/transform";

/** Mock Two Minutes: only `route` exists; everything else 404s like the real API. */
function mockTmr(route: string, opts: { spec?: boolean; status?: number; rateLimitFirst?: number } = {}) {
  const hits: string[] = [];
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
      res.writeHead(opts.status ?? 200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ connectorResults: [{ results: [{ data: { headers: ["a", "b", "c", "d", "e", "f", "g", "h"], rows: [["1", "OUTCOME_SALES", "REACH", "2025-Jun", 1, 2, 3, 4]] } }] }] }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: `Cannot ${req.method} ${req.url}` } }));
  });
  return { server, hits };
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
    const { server, hits } = mockTmr("/data/query");
    servers.push(server);
    const table = await runQuery(req, cfg(await listen(server)), quiet);
    assert.equal(table.rows.length, 1);
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
