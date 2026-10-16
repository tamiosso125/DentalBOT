/**
 * Panel session: a signed, expiring cookie value "<payload>.<hmac>", where the payload is the
 * signed-in staff member and the expiry, as base64url JSON. Uses Web Crypto so the same code
 * runs in the middleware (edge) and in server actions (node). The API checks on every request
 * that the person is still active, so deactivating a login cuts it off at once.
 */
export const SESSION_COOKIE = "dentalbot_panel";
export const SESSION_HOURS = 12;

export type StaffRole = "RECEPTION" | "DENTIST";
export type SessionUser = { id: string; name: string; role: StaffRole };

const encoder = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(text: string): string {
  const bytes = encoder.encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function createSession(
  secret: string,
  user: SessionUser,
  now = Date.now(),
): Promise<string> {
  const payload = toBase64Url(
    JSON.stringify({
      exp: now + SESSION_HOURS * 3_600_000,
      id: user.id,
      name: user.name,
      role: user.role,
    }),
  );
  return `${payload}.${await hmac(secret, payload)}`;
}

/** The signed-in person, or null for a missing, forged, malformed or expired cookie. */
export async function readSession(
  value: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<SessionUser | null> {
  if (!value) return null;
  const [payload, sig, extra] = value.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, await hmac(secret, payload))) return null;
  try {
    const p = JSON.parse(fromBase64Url(payload)) as Record<string, unknown>;
    if (typeof p.exp !== "number" || p.exp <= now) return null;
    if (typeof p.id !== "string" || typeof p.name !== "string") return null;
    if (p.role !== "RECEPTION" && p.role !== "DENTIST") return null;
    return { id: p.id, name: p.name, role: p.role };
  } catch {
    return null;
  }
}
