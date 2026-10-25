import { allowedDomain, signIn } from "@/auth";

export const metadata = { title: "Sign in · Media Benchmarks" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const { callbackUrl, error } = await searchParams;
  const safeCallback = callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//") ? callbackUrl : "/";
  return (
    <main className="signin">
      <div className="signin-card">
        <p className="eyebrow">MajorForm</p>
        <h1>Media Benchmarks</h1>
        <p className="muted">Sign in with your @{allowedDomain()} Google account.</p>
        {error && <p className="error-text">That account can&apos;t sign in here. Use your @{allowedDomain()} account.</p>}
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: safeCallback });
          }}
        >
          <button className="btn btn-primary" type="submit">
            Continue with Google
          </button>
        </form>
      </div>
    </main>
  );
}
