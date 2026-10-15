#!/usr/bin/env node
// PreToolUse (Edit|Write|MultiEdit): blocks writing CPF, phone numbers or real tokens into files.
// Exit code 2 blocks the tool call and shows stderr to Claude.
import { findSensitiveData, textFromToolInput } from "./sensitive-patterns.mjs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const file = input.tool_input?.file_path ?? "";
// Local secrets files are git-ignored and may hold real tokens.
if (/(^|\/)\.env(\.[\w-]+)?$/.test(file) && !file.endsWith(".env.example")) process.exit(0);

const findings = findSensitiveData(textFromToolInput(input.tool_input));
if (findings.length > 0) {
  process.stderr.write(
    `Bloqueado pelo hook do dentalbot-dev: o conteúdo parece ter dado pessoal ou segredo real ` +
      `(${findings.join("; ")}). Use dados fictícios (CPF 529.982.247-25, celular 55 11 90000-XXXX) ` +
      `e segredos só no .env.\n`,
  );
  process.exit(2);
}
