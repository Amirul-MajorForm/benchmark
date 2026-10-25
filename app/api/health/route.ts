import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Railway healthcheck: the app is up and can reach Postgres. Public, reveals nothing. */
export async function GET() {
  try {
    await getPool().query("select 1");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
