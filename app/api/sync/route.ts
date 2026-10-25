import { NextResponse } from "next/server";
import { invalidateFactsCache, loadSyncStatus } from "@/lib/benchmarks";
import { runSync } from "@/lib/sync";

export const dynamic = "force-dynamic";

/** "Sync now". Starts the sync in the background and returns straight away; a second click while it runs is refused. */
export async function POST() {
  if (!process.env.TMR_API_KEY) return NextResponse.json({ error: "TMR_API_KEY is not set on this service" }, { status: 500 });
  const status = await loadSyncStatus();
  if (status.latest?.status === "running") return NextResponse.json({ status: "running" }, { status: 409 });
  void runSync()
    .then(invalidateFactsCache)
    .catch((err) => console.error("sync now failed:", err));
  return NextResponse.json({ status: "started" }, { status: 202 });
}

export async function GET() {
  const status = await loadSyncStatus();
  return NextResponse.json({ lastSuccessAt: status.lastSuccessAt, latest: status.latest });
}
