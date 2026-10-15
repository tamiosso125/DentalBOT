// Detects real-looking personal data and secrets in text about to be written to the repo.
// Shared by the PreToolUse hook and its unit test.

/** Public example CPFs that are fine in tests and docs. */
const ALLOWED_CPFS = new Set(["52998224725"]);

function isValidCpf(digits) {
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
  const d = digits.split("").map(Number);
  const check = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += d[i] * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === d[9] && check(10) === d[10];
}

const SECRET_PATTERNS = [
  ["token da Meta (EAA...)", /\bEAA[A-Za-z0-9]{60,}\b/],
  ["chave do Asaas", /\$aact_[A-Za-z0-9_]{20,}/],
  ["chave da Anthropic", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["chave privada", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/**
 * Returns a list of human-readable findings (pt-BR). Empty = ok.
 * Test phone convention: 55 + DDD + 90000-XXXX (e.g. 5511900000001) is allowed.
 */
export function findSensitiveData(text) {
  const findings = [];

  const cpfRanges = [];
  for (const m of text.matchAll(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (!isValidCpf(digits)) continue;
    cpfRanges.push([m.index, m.index + m[0].length]);
    if (!ALLOWED_CPFS.has(digits)) findings.push(`CPF válido (${m[0]})`);
  }
  const insideCpf = (i) => cpfRanges.some(([a, b]) => i >= a && i < b);

  for (const m of text.matchAll(/(?:\+?55\s?)?\(?([1-9]\d)\)?\s?(9\d{4})[-\s]?(\d{4})\b/g)) {
    if (insideCpf(m.index)) continue;
    const subscriber = `${m[2]}${m[3]}`;
    if (!subscriber.startsWith("90000")) findings.push(`celular brasileiro (${m[0].trim()})`);
  }

  for (const [label, re] of SECRET_PATTERNS) {
    if (re.test(text)) findings.push(label);
  }
  return findings;
}

/** Extracts the text a Write/Edit/MultiEdit call would put in the file. */
export function textFromToolInput(toolInput) {
  if (!toolInput) return "";
  const parts = [toolInput.content, toolInput.new_string];
  for (const e of toolInput.edits ?? []) parts.push(e.new_string);
  return parts.filter((p) => typeof p === "string").join("\n");
}
