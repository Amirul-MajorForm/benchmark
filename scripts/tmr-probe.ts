/**
 * Confirms the Two Minute Reports REST request/response shape with one tiny query
 * (OATSIDE, June 2025, spend by year_month) before trusting the sync with it.
 *
 *   npm run tmr:probe
 *
 * Tries TMR_QUERY_PATH first, then a few likely alternatives, with raw and "fads_"-prefixed
 * field ids, and prints the env values to set for the first combination that works.
 */
import { buildBody, configFromEnv, extractTable, queryUrl } from "../lib/tmr";
import { mainQuery } from "../lib/transform";

const CANDIDATE_PATHS = [
  "/teams/{teamId}/query",
  "/teams/{teamId}/data/query",
  "/teams/{teamId}/queries/run",
  "/teams/{teamId}/run-query",
  "/data/query",
  "/query",
];

async function main() {
  const base = configFromEnv();
  const paths = [...new Set([base.queryPath, ...CANDIDATE_PATHS])];
  const q = mainQuery("2025-06-01", "2025-06-30");
  q.dimensions = ["account_id", "year_month"];
  q.metrics = ["spend"];
  const req = { connectorId: "fads", accountIds: ["act_764971328270854"], currencyCode: "SGD", title: "probe", query: q };

  for (const queryPath of paths) {
    for (const fieldPrefix of ["", "fads_"]) {
      const cfg = { ...base, queryPath, fieldPrefix };
      const url = queryUrl(cfg);
      process.stdout.write(`POST ${url} (fields ${fieldPrefix ? "prefixed" : "raw"}) ... `);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(buildBody(cfg, req)),
          signal: AbortSignal.timeout(90_000),
        });
      } catch (err) {
        console.log(`network error: ${(err as Error).message}`);
        continue;
      }
      const text = await res.text();
      console.log(res.status);
      if (res.status === 404 || res.status === 405) break; // path is wrong, prefix will not help
      if (!res.ok) {
        console.log(`  ${text.slice(0, 300)}`);
        if (res.status === 401 || res.status === 403) {
          console.log("\nAuth failed: check TMR_API_KEY is an API key (not MCP) with scope data:read.");
          return;
        }
        continue;
      }
      try {
        const table = extractTable(JSON.parse(text), req);
        console.log("\nResponse parsed. Raw body (first 800 chars):\n" + text.slice(0, 800));
        console.log(`\nRows: ${JSON.stringify(table.rows)}`);
        console.log("Expected OATSIDE June 2025 spend from the prototype data: S$20,160.87 (all objectives).");
        console.log(`\nSet these on Railway:\n  TMR_QUERY_PATH=${queryPath}\n  TMR_FIELD_PREFIX=${fieldPrefix}`);
        return;
      } catch (err) {
        console.log(`  2xx but unexpected shape: ${(err as Error).message}`);
        console.log(`  body: ${text.slice(0, 800)}`);
        return;
      }
    }
  }
  console.log("\nNo candidate worked. Open the docs' Data -> Run query page and set TMR_QUERY_PATH accordingly.");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
