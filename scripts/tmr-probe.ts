/**
 * Checks the Two Minute Reports REST setup with one tiny query (OATSIDE, June 2025, spend)
 * before trusting the sync with it:
 *
 *   npm run tmr:probe
 *
 * Finds the Run query endpoint (TMR_QUERY_PATH, then the server's OpenAPI spec, then likely
 * paths), runs the query and prints what came back.
 */
import { configFromEnv, resolveQueryPath, runQuery } from "../lib/tmr";

async function main() {
  const cfg = configFromEnv();
  const req = {
    connectorId: "fads",
    accountIds: ["act_764971328270854"],
    title: "probe",
    query: {
      dateRange: { startDate: "2025-06-01", endDate: "2025-06-30" },
      dimensions: ["account_id", "year_month"],
      metrics: ["spend"],
      reportParams: { includeAllItems: true },
    },
  };
  const path = await resolveQueryPath(req, cfg);
  console.log(`Endpoint: POST ${cfg.baseUrl}${path}`);
  try {
    const table = await runQuery(req, { ...cfg, retries: 0 });
    console.log(`Rows: ${JSON.stringify(table.rows)}`);
    console.log("Spend is in the account's own currency (OATSIDE is SGD-billed: expect S$20,160.87 for June 2025).");
    console.log(`\nWorking. Optionally set TMR_QUERY_PATH=${path} on Railway.`);
  } catch (err) {
    console.log(`The endpoint exists but the query failed: ${(err as Error).message}`);
    if (/field|metric|dimension/i.test((err as Error).message) && !cfg.fieldPrefix) {
      console.log("If it is complaining about field ids, try TMR_FIELD_PREFIX=fads_");
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
