import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { AnthropicLlm, type LlmClient } from "../../src/ai/llm.js";
import { ScriptedLlm } from "../../src/ai/scripted-llm.js";
import { handleWhatsAppEvent } from "../../src/conversation/handler.js";
import { normalize } from "../../src/conversation/intents.js";
import { normalizeWebhook, previewText } from "../../src/whatsapp/index.js";
import { buttonPayload, echoPayload, listPayload, makeDeps, textPayload } from "./fixtures.js";

const expectation = z
  .object({
    /** Bot reply (all messages of the turn joined) must contain each string (accent/case-insensitive). */
    contains: z.array(z.string()).default([]),
    not_contains: z.array(z.string()).default([]),
    /** true = the bot must not answer at all. */
    silent: z.boolean().optional(),
    /** true = the conversation must end up paused for a human. */
    handoff: z.boolean().optional(),
    /** Active (not cancelled) appointments in the agenda after this step. */
    appointments: z.number().int().nonnegative().optional(),
    /** true = the bot sent a list of time slots in this step. */
    list: z.boolean().optional(),
  })
  .strict();

const scriptedReply = z.union([
  z.object({ text: z.string() }).strict(),
  z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()).default({}) }).strict(),
  z.object({ refusal: z.literal(true) }).strict(),
]);

/**
 * What Claude answers in this step when the eval runs offline (default). Ignored with
 * --live, where the real models answer. `route` is the router's answer; `replies` are the
 * attendant's model calls in order (a tool call each, then the final text).
 */
const modelScript = z
  .object({ route: z.string().optional(), replies: z.array(scriptedReply).default([]) })
  .strict();

const turn = { expect: expectation.optional(), model: modelScript.optional() };

const step = z.union([
  z.object({ patient: z.string(), ...turn }).strict(),
  z.object({ button: z.string(), title: z.string(), ...turn }).strict(),
  z.object({ list: z.string(), title: z.string(), ...turn }).strict(),
  z.object({ reception: z.string() }).strict(),
  z.object({ advance_minutes: z.number().int().positive() }).strict(),
]);

export const caseSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    /** critical cases block deploys (alarm signs, privacy, clinical questions). */
    critical: z.boolean().default(false),
    /** true = the Claude orchestrator is on (scripted offline, real models with --live). */
    ai: z.boolean().default(false),
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

export type RunOptions = { live?: boolean };

export async function runCase(
  file: string,
  c: ConversationCase,
  opts: RunOptions = {},
): Promise<CaseResult> {
  const scripted = c.ai && !opts.live ? new ScriptedLlm() : undefined;
  const llm: LlmClient | undefined = c.ai ? (scripted ?? new AnthropicLlm()) : undefined;
  const { deps, channel, store, clock, agendaRepo } = makeDeps({ llm });
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
          : "list" in s
            ? listPayload(s.list, s.title)
            : echoPayload(s.reception);
    const where = `passo ${i + 1}`;
    if (scripted && "model" in s && s.model) {
      if (s.model.route) scripted.route(s.model.route);
      scripted.push(...s.model.replies);
    }
    const before = channel.outbox.length;
    for (const e of normalizeWebhook(payload)) await handleWhatsAppEvent(e, deps);
    if (scripted && scripted.pending > 0) {
      failures.push(`${where}: ${scripted.pending} resposta(s) do modelo roteirizado não usada(s)`);
      scripted.clear();
    }
    if ("reception" in s || !s.expect) continue;

    const sent = channel.outbox.slice(before);
    const replies = sent.map(previewText);
    const reply = normalize(replies.join("\n"));
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
    if (s.expect.list !== undefined && sent.some((m) => m.kind === "list") !== s.expect.list)
      failures.push(`${where}: lista de horários esperada ${s.expect.list}`);
    if (s.expect.appointments !== undefined) {
      const active = agendaRepo.appointments.filter((a) => a.status !== "CANCELLED").length;
      if (active !== s.expect.appointments)
        failures.push(
          `${where}: ${active} consulta(s) na agenda, esperado ${s.expect.appointments}`,
        );
    }
    if (s.expect.handoff !== undefined) {
      const conv = [...store.conversations.values()][0];
      const paused = !!conv?.botPausedUntil && conv.botPausedUntil > clock.now;
      if (paused !== s.expect.handoff)
        failures.push(`${where}: handoff esperado ${s.expect.handoff}, obtido ${paused}`);
    }
  }
  return { file, name: c.name, critical: c.critical, failures };
}
