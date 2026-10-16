/** Lower case, no accents, single spaces: "  JOSÉ  da Conceição " -> "jose da conceicao". */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Every word of the search must appear in the name, in any order, ignoring accents and case. */
export function nameMatches(name: string, search: string): boolean {
  const haystack = foldText(name);
  const words = foldText(search).split(" ").filter(Boolean);
  return words.length > 0 && words.every((w) => haystack.includes(w));
}

/** "15/03/1990" or "1990-03-15" as YYYY-MM-DD, or null if it is not a real calendar date. */
export function parseBirthDate(text: string): string | null {
  const t = text.trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const [y, m, d] = br ? [br[3]!, br[2]!, br[1]!] : iso ? [iso[1]!, iso[2]!, iso[3]!] : [];
  if (!y || !m || !d) return null;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  const valid =
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === `${y}-${m}-${d}`;
  return valid ? `${y}-${m}-${d}` : null;
}
