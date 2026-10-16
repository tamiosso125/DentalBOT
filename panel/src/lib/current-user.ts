import "server-only";
import { cookies } from "next/headers";
import { readSession, SESSION_COOKIE, type SessionUser } from "./session";

/** The staff member signed in to this request, or null (no cookie, or outside a request). */
export async function currentUser(): Promise<SessionUser | null> {
  const secret = process.env.PANEL_SESSION_SECRET;
  if (!secret) return null;
  try {
    return await readSession((await cookies()).get(SESSION_COOKIE)?.value, secret);
  } catch {
    return null;
  }
}
