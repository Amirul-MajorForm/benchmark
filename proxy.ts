import { type NextRequest, NextResponse } from "next/server";

/**
 * Open access by default. Set BASIC_AUTH_PASSWORD (and optionally BASIC_AUTH_USER, default
 * "majorform") to put the whole app behind one shared password.
 */
export default function proxy(req: NextRequest) {
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (!password || req.nextUrl.pathname === "/api/health") return NextResponse.next();

  const [scheme, encoded] = (req.headers.get("authorization") ?? "").split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, ...rest] = Buffer.from(encoded, "base64").toString().split(":");
    if (user === (process.env.BASIC_AUTH_USER || "majorform") && rest.join(":") === password) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Media Benchmarks"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
