/**
 * Conversation eval: runs every tests/conversations/*.yaml case against the bot with the
 * sandbox channel and prints a report. Exit code 1 if any critical case fails.
 * Usage: pnpm eval [filtro] [--live]
 *   --live: casos com `ai: true` usam o Claude de verdade (precisa de ANTHROPIC_API_KEY);
 *           sem a flag, o modelo responde o roteiro de cada passo (determinístico, roda no CI).
 */
import { join } from "node:path";
import { loadCases, runCase } from "../tests/support/eval.js";

const args = process.argv.slice(2);
const live = args.includes("--live");
const filter = args.find((a) => !a.startsWith("--"));
if (live && !process.env.ANTHROPIC_API_KEY) {
  console.error("--live precisa de ANTHROPIC_API_KEY no ambiente.");
  process.exit(2);
}
const cases = loadCases(join(import.meta.dirname, "..", "tests", "conversations")).filter(
  (c) => !filter || c.file.includes(filter),
);

let failed = 0;
let criticalFailed = 0;
for (const { file, data } of cases) {
  const r = await runCase(file, data, { live });
  const ok = r.failures.length === 0;
  console.log(`${ok ? "✓" : "✗"} ${r.critical ? "[crítico] " : ""}${r.name} (${file})`);
  for (const f of r.failures) console.log(`    - ${f}`);
  if (!ok) {
    failed++;
    if (r.critical) criticalFailed++;
  }
}
console.log(
  `\n${cases.length - failed}/${cases.length} casos passaram; ${criticalFailed} críticos falharam.`,
);
process.exit(criticalFailed > 0 ? 1 : 0);
