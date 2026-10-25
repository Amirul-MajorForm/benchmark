import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";
import { auth, authMode } from "./auth";

const PUBLIC = [/^\/api\/auth(\/|$)/, /^\/api\/health$/, /^\/signin$/];

const googleGate = auth((req) => {
  if (req.auth) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const url = new URL("/signin", req.nextUrl.origin);
  url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}) as unknown as (req: NextRequest, ev: NextFetchEvent) => Promise<Response>;

function basicGate(req: NextRequest): Response {
  const header = req.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, ...rest] = Buffer.from(encoded, "base64").toString().split(":");
    const expectedUser = process.env.BASIC_AUTH_USER || "majorform";
    if (user === expectedUser && rest.join(":") === process.env.BASIC_AUTH_PASSWORD) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Media Benchmarks"' },
  });
}

export default function proxy(req: NextRequest, ev: NextFetchEvent) {
  if (PUBLIC.some((p) => p.test(req.nextUrl.pathname))) return NextResponse.next();
  const mode = authMode();
  if (mode === "google") return googleGate(req, ev);
  if (mode === "basic") return basicGate(req);
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Sign-in is not configured. Set AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET or BASIC_AUTH_PASSWORD.", { status: 503 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
