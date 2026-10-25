import { adminEmails, auth, authMode } from "@/auth";

export type Viewer = { email: string | null; isAdmin: boolean; mode: ReturnType<typeof authMode> };

/**
 * Google mode: admins are ADMIN_EMAILS. Basic mode has one shared login, so it can run syncs.
 * No auth (local dev only; production refuses to serve without auth): admin.
 */
export async function getViewer(): Promise<Viewer> {
  const mode = authMode();
  if (mode !== "google") return { email: null, isAdmin: true, mode };
  const session = await auth();
  const email = session?.user?.email?.toLowerCase() ?? null;
  return { email, isAdmin: !!email && adminEmails().includes(email), mode };
}
