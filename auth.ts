import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const allowedDomain = () => (process.env.ALLOWED_EMAIL_DOMAIN || "majorform.co").toLowerCase();

export const adminEmails = () =>
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

/** google when Google sign-in is configured, else basic when a password is set, else none (local dev only). */
export function authMode(): "google" | "basic" | "none" {
  if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) return "google";
  if (process.env.BASIC_AUTH_PASSWORD) return "basic";
  return "none";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [
    Google({
      authorization: { params: { hd: allowedDomain(), prompt: "select_account" } },
    }),
  ],
  pages: { signIn: "/signin", error: "/signin" },
  callbacks: {
    // Only verified Google accounts on the MajorForm domain get in.
    signIn({ profile }) {
      const email = profile?.email?.toLowerCase();
      return !!email && profile?.email_verified !== false && email.endsWith(`@${allowedDomain()}`);
    },
  },
});
