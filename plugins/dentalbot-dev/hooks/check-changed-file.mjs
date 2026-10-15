#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit): lints the changed TypeScript file and runs related tests.
// Exit code 2 sends the failure back to Claude so it fixes it right away.
import { execFileSync } from "node:child_process";
import { relative } from "node:path";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const cwd = input.cwd ?? process.cwd();
const file = input.tool_input?.file_path;
if (!file || !/\.(ts|tsx)$/.test(file)) process.exit(0);
const rel = relative(cwd, file);
if (rel.startsWith("..") || rel.startsWith("node_modules")) process.exit(0);

function run(args) {
  try {
    execFileSync("pnpm", ["--silent", "exec", ...args], { cwd, stdio: "pipe", timeout: 100_000 });
    return null;
  } catch (err) {
    return `${err.stdout ?? ""}${err.stderr ?? ""}`.slice(-4000);
  }
}

const lint = run(["eslint", rel]);
const tests = run(["vitest", "related", "--run", "--passWithNoTests", rel]);
if (lint || tests) {
  process.stderr.write(
    `Verificação após editar ${rel} falhou:\n${lint ? `ESLint:\n${lint}\n` : ""}${tests ? `Vitest:\n${tests}\n` : ""}`,
  );
  process.exit(2);
}
