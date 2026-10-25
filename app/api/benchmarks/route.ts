import { NextResponse, type NextRequest } from "next/server";
import { buildView, loadFacts, loadSyncStatus, parseFilters } from "@/lib/benchmarks";

export const dynamic = "force-dynamic";

/** GET /api/benchmarks?period=2025-Q2&objective=OUTCOME_AWARENESS&goal=REACH&market=MY ... */
export async function GET(req: NextRequest) {
  const filters = parseFilters(Object.fromEntries(req.nextUrl.searchParams));
  const sync = await loadSyncStatus();
  const facts = await loadFacts(sync.lastSuccessAt);
  const { options, ...view } = buildView(facts, filters);
  return NextResponse.json({ ...view, options, lastSyncedAt: sync.lastSuccessAt });
}
