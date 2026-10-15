import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { handleWhatsAppEvent } from "../../src/conversation/handler.js";
import { normalize } from "../../src/conversation/intents.js";
import { normalizeWebhook, previewText } from "../../src/whatsapp/index.js";
import { buttonPayload, echoPayload, makeDeps, textPayload } from "./fixtures.js";

const expectation = z
  .object({
    /** Bot reply (all messages of the turn joined) must contain each string (accent/case-insensitive). */
    contains: z.array(z.string()).default([]),
    not_contains: z.array(z.string()).default([]),
    /** true = the bot must not answer at all. */
    silent: z.boolean().optional(),
    /** true = the conversation must end up paused for a human. */
    handoff: z.boolean().optional(),
  })
  .strict();

const step = z.union([
  z.object({ patient: z.string(), expect: expectation.optional() }).strict(),
  z.object({ button: z.string(), title: z.string(), expect: expectation.optional() }).strict(),
  z.object({ reception: z.string() }).strict(),
  z.object({ advance_minutes: z.number().int().positive() }).strict(),
]);

export const caseSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    /** critical cases block deploys (alarm signs, privacy, clinical questions). */
    critical: z.boolean().default(false),
    steps: z.array(step).min(1),
  })
  .strict();

export type ConversationCase = z.infer<typeof caseSchema>;
export type CaseResult = { file: string; name: string; critical: boolean; failures: string[] };

export function loadCases(dir: string): Array<{ file: string; data: ConversationCase }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()
    .map((file) => ({
      file,
      data: caseSchema.parse(parse(readFileSync(join(dir, file), "utf8"))),
    }));
}

export async function runCase(file: string, c: ConversationCase): Promise<CaseResult> {
  const { deps, channel, store, clock } = makeDeps();
  const failures: string[] = [];

  for (const [i, s] of c.steps.entries()) {
    if ("advance_minutes" in s) {
      clock.now = new Date(clock.now.getTime() + s.advance_minutes * 60_000);
      continue;
    }
    const payload =
      "patient" in s
        ? textPayload(s.patient)
        : "button" in s
          ? buttonPayload(s.button, s.title)
          : echoPayload(s.reception);
    const before = channel.outbox.length;
    for (const e of normalizeWebhook(payload)) await handleWhatsAppEvent(e, deps);
    if ("reception" in s || !s.expect) continue;

    const replies = channel.outbox.slice(before).map(previewText);
    const reply = normalize(replies.join("\n"));
    const where = `passo ${i + 1}`;
    for (const want of s.expect.contains) {
      if (!reply.includes(normalize(want)))
        failures.push(`${where}: resposta não contém "${want}"`);
    }
    for (const bad of s.expect.not_contains) {
      if (reply.includes(normalize(bad))) failures.push(`${where}: resposta contém "${bad}"`);
    }
    if (s.expect.silent === true && replies.length > 0)
      failures.push(`${where}: bot respondeu, devia ficar em silêncio`);
    if (s.expect.silent === false && replies.length === 0)
      failures.push(`${where}: bot não respondeu`);
    if (s.expect.handoff !== undefined) {
      const conv = [...store.conversations.values()][0];
      const paused = !!conv?.botPausedUntil && conv.botPausedUntil > clock.now;
      if (paused !== s.expect.handoff)
        failures.push(`${where}: handoff esperado ${s.expect.handoff}, obtido ${paused}`);
    }
  }
  return { file, name: c.name, critical: c.critical, failures };
}
