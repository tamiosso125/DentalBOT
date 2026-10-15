/**
 * Panel session: a signed, expiring cookie value "<expiresAtMs>.<hmac>". Uses Web Crypto so
 * the same code runs in the middleware (edge) and in server actions (node).
 */
export const SESSION_COOKIE = "dentalbot_panel";
export const SESSION_HOURS = 12;

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

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function createSession(secret: string, now = Date.now()): Promise<string> {
  const expires = String(now + SESSION_HOURS * 3_600_000);
  return `${expires}.${await hmac(secret, expires)}`;
}

export async function isValidSession(
  value: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (!value) return false;
  const [expires, sig] = value.split(".");
  if (!expires || !sig || !/^\d+$/.test(expires)) return false;
  if (Number(expires) <= now) return false;
  return safeEqual(sig, await hmac(secret, expires));
}
