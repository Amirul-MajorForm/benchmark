import { NextResponse } from "next/server";
import { invalidateFactsCache, loadSyncStatus } from "@/lib/benchmarks";
import { runSync } from "@/lib/sync";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/** Admin-only "Sync now". Starts the sync in the background and returns straight away. */
export async function POST() {
  const viewer = await getViewer();
  if (!viewer.isAdmin) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  if (!process.env.TMR_API_KEY) return NextResponse.json({ error: "TMR_API_KEY is not set on this service" }, { status: 500 });
  const status = await loadSyncStatus();
  if (status.latest?.status === "running") return NextResponse.json({ status: "running" }, { status: 409 });
  void runSync()
    .then(invalidateFactsCache)
    .catch((err) => console.error("sync now failed:", err));
  return NextResponse.json({ status: "started" }, { status: 202 });
}

export async function GET() {
  const viewer = await getViewer();
  const status = await loadSyncStatus();
  return NextResponse.json({
    lastSuccessAt: status.lastSuccessAt,
    latest: status.latest && { ...status.latest, error: viewer.isAdmin ? status.latest.error : undefined },
  });
}
