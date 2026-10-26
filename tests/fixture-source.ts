import { readFileSync } from "node:fs";
import path from "node:path";
import { extractTable, type TmrQuery, type TmrTable } from "../lib/tmr";

const load = (name: string) => JSON.parse(readFileSync(path.join(__dirname, "fixtures", name), "utf8"));

/**
 * Stands in for the TMR API during tests: serves the recorded Two Minutes responses
 * (Q2 2025 main query, H1 2025 purchases query) and empty tables for any other range.
 * Recorded responses go through the same extractTable as live ones.
 */
export function fixtureQuery() {
  const main = load("meta-main-2025-q2.json");
  const purchases = load("meta-purchases-2025-h1.json");
  const calls: string[] = [];
  const query = async (title: string, q: TmrQuery): Promise<TmrTable> => {
    const { startDate, endDate } = q.dateRange;
    calls.push(`${title} ${startDate}..${endDate}`);
    if (q.dimensions.includes("date")) return { fields: [...q.dimensions, ...q.metrics], rows: [] }; // daily spend: not recorded
    const isPurchases = q.metrics.includes("collab_action_omni_purchase");
    if (isPurchases && startDate === "2025-01-01" && endDate === "2025-06-30") return extractTable(purchases, { query: q });
    if (!isPurchases && startDate === "2025-04-01" && endDate === "2025-06-30") {
      // Recorded with currencyCode SGD through MCP, so spend is already SGD: label every row "SGD"
      // (the account_currency column the live query asks for) and the conversion is a no-op.
      const recordedQuery = { ...q, dimensions: q.dimensions.filter((d) => d !== "account_currency") };
      const t = extractTable(main, { query: recordedQuery });
      const at = q.dimensions.indexOf("account_currency");
      return { fields: [...q.dimensions, ...q.metrics], rows: t.rows.map((r) => [...r.slice(0, at), "SGD", ...r.slice(at)]) };
    }
    return { fields: [...q.dimensions, ...q.metrics], rows: [] };
  };
  return { query, calls };
}
