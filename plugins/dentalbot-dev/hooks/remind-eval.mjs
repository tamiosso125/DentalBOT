#!/usr/bin/env node
// Stop: if conversation code, patient texts or eval cases changed, remind to run the eval.
import { execFileSync } from "node:child_process";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let input = {};
try {
  input = JSON.parse(raw);
} catch {
  // ignore
}

let changed = "";
try {
  changed = execFileSync("git", ["status", "--porcelain", "-uall"], {
    cwd: input.cwd ?? process.cwd(),
    encoding: "utf8",
  });
} catch {
  process.exit(0);
}

const watched = /(src\/conversation\/|src\/whatsapp\/templates|tests\/conversations\/|prompts?\/)/;
if (changed.split("\n").some((line) => watched.test(line))) {
  process.stdout.write(
    JSON.stringify({
      systemMessage:
        "Arquivos de conversa, textos ou templates mudaram: rode `pnpm eval` antes de abrir o PR (casos críticos bloqueiam deploy).",
    }),
  );
}
