/**
 * Log redaction. Health data is sensitive under LGPD (art. 11): logs must never carry
 * CPF, full phone numbers, e-mails, symptoms or message contents.
 */

/** Keys whose values are always dropped from logs, whatever they contain. */
const SENSITIVE_KEYS = new Set(
  [
    "cpf",
    "phone",
    "telefone",
    "wa_id",
    "from",
    "to",
    "recipient_id",
    "email",
    "name",
    "nome",
    "text",
    "body",
    "caption",
    "message",
    "messages",
    "message_echoes",
    "contacts",
    "profile",
    "symptoms",
    "sintomas",
    "insuranceCard",
    "carteirinha",
    "birthDate",
    "address",
    "authorization",
    "access_token",
    "accessToken",
    "apiKey",
    "password",
    "secret",
    "token",
  ].map((k) => k.toLowerCase()),
);

const CPF_RE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
// Brazilian phones with optional +55 and area code: 11 90000-0000, +5511900000000, etc.
const PHONE_RE = /(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

export const REDACTED = "[REDACTED]";

export function redactText(value: string): string {
  return value.replace(EMAIL_RE, REDACTED).replace(CPF_RE, REDACTED).replace(PHONE_RE, REDACTED);
}

/** Deep-copies a value replacing sensitive keys and patterns. Safe to pass anything. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return REDACTED as T;
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) } as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Shows only the last 4 digits, for support screens ("final 4321"). */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length <= 4 ? "****" : `***${digits.slice(-4)}`;
}
