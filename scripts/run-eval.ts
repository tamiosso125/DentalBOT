/**
 * Conversation eval: runs every tests/conversations/*.yaml case against the bot with the
 * sandbox channel and prints a report. Exit code 1 if any critical case fails.
 * Usage: pnpm eval [filtro]
 */
import { join } from "node:path";
import { loadCases, runCase } from "../tests/support/eval.js";

const filter = process.argv[2];
const cases = loadCases(join(import.meta.dirname, "..", "tests", "conversations")).filter(
  (c) => !filter || c.file.includes(filter),
);

let failed = 0;
let criticalFailed = 0;
for (const { file, data } of cases) {
  const r = await runCase(file, data);
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
