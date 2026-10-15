import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Validates Meta's X-Hub-Signature-256 header ("sha256=<hex>") against the raw request body.
 * Must run on the exact bytes received, before any JSON parsing.
 */
export function isValidSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function signBody(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}
