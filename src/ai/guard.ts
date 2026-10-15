import { redactText } from "../privacy/index.js";

/**
 * Output guard: the last check before a model-written reply reaches the patient.
 * Deterministic on purpose. Blocks prices outside the clinic's table, clock times that no
 * tool returned (the model must never invent a slot) and anything that looks like a CPF,
 * phone number or e-mail.
 */
export type GuardInput = { allowedTimes: Set<string>; allowedPrices: Set<number> };
export type GuardResult = { ok: true } | { ok: false; reason: "price" | "time" | "personal_data" };

const PRICE_RE = /R\$\s?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/g;
// "09:00", "9:30" anywhere; "9h", "14h30" only after a time preposition, so "24h" or
// "resposta em 1h" do not count as appointment times.
const CLOCK_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
const HOUR_RE =
  /(?<!\p{L})(?:às|as|das|até|ate|entre|e|partir das)\s+([01]?\d|2[0-3])h([0-5]\d)?\b/giu;

export function checkReply(text: string, allowed: GuardInput): GuardResult {
  if (redactText(text) !== text) return { ok: false, reason: "personal_data" };

  for (const m of text.matchAll(PRICE_RE)) {
    const cents = Number(m[1]!.replace(/\./g, "")) * 100 + Number(m[2] ?? 0);
    if (!allowed.allowedPrices.has(cents)) return { ok: false, reason: "price" };
  }
  for (const m of [...text.matchAll(CLOCK_RE), ...text.matchAll(HOUR_RE)]) {
    const time = `${m[1]!.padStart(2, "0")}:${m[2] ?? "00"}`;
    if (!allowed.allowedTimes.has(time)) return { ok: false, reason: "time" };
  }
  return { ok: true };
}
