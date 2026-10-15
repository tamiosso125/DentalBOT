import type Anthropic from "@anthropic-ai/sdk";
import type { ClinicInfo, ConversationRecord, ConversationStore } from "../conversation/store.js";
import type { Logger } from "../lib/logger.js";
import type { AgendaProvider } from "../scheduling/agenda-provider.js";
import { formatShortPtBr, formatTimePtBr, formatWhenPtBr } from "../scheduling/time.js";
import type { WaitlistService } from "../waitlist/waitlist.js";
import { checkReply } from "./guard.js";
import { MODELS, textOf, type LlmClient } from "./llm.js";
import { attendantSystemPrompt } from "./prompt.js";
import { routeMessage, type Route } from "./router.js";
import { loadState, type AgentState } from "./state.js";
import {
  openingTimes,
  runTool,
  TOOL_DEFINITIONS,
  type HandoffReason,
  type ToolContext,
} from "./tools.js";

export type AttendantEffort = "low" | "medium" | "high";

export type OrchestratorDeps = {
  llm: LlmClient;
  store: ConversationStore;
  /** Agenda bound to one clinic; null if the clinic has no agenda configured. */
  agendaFor(clinicId: string): Promise<AgendaProvider | null>;
  logger: Logger;
  effort?: AttendantEffort;
  /** Waiting list (entrar_lista_espera). Absent = the tool hands off to the front desk. */
  waitlist?: Pick<WaitlistService, "join">;
};

export type ListMessage = {
  body: string;
  button: string;
  rows: Array<{ id: string; title: string; description?: string }>;
};

/**
 * What the handler should do with the patient's message:
 * - route: a fixed path with an approved text (handoff, emergency, menu);
 * - reply: a model-written text that already passed the output guard, plus optional list.
 */
export type AiOutcome =
  | { kind: "route"; route: Exclude<Route, "agenda" | "info" | "outro"> }
  | {
      kind: "reply";
      text: string;
      list?: ListMessage;
      handoff?: HandoffReason | "guard" | "error";
    };

export type AiInput = {
  conv: ConversationRecord;
  clinic: ClinicInfo;
  /** Text of the patient's message (already stored as the last inbound message). */
  text: string;
  replyId?: string;
  now: Date;
};

const HISTORY_WINDOW_MS = 24 * 60 * 60_000;
const HISTORY_LIMIT = 24;
const MAX_MODEL_CALLS = 6;
const SLOT_REPLY = /^slot:(\d+)$/;

/** Fallback when the model fails or the guard blocks its reply. Approved text. */
export const AI_FALLBACK =
  "Desculpe, não consegui concluir por aqui. Já chamei a recepção, que continua com você em breve.";

export async function respond(input: AiInput, deps: OrchestratorDeps): Promise<AiOutcome> {
  const { conv, now } = input;
  const log = deps.logger.child({ conversationId: conv.id });
  try {
    const recent = await deps.store.recentMessages(
      conv.id,
      new Date(now.getTime() - HISTORY_WINDOW_MS),
      HISTORY_LIMIT,
    );
    // Everything before the patient's current message (stored last as INBOUND; the privacy
    // notice of a first contact may come after it).
    const history = recent.slice(
      0,
      Math.max(
        0,
        recent.findLastIndex((m) => m.direction === "INBOUND"),
      ),
    );
    const slotChoice = input.replyId?.match(SLOT_REPLY);

    // A tap on a slot of our own list is unambiguous: skip the router.
    if (!slotChoice) {
      const route = await routeMessage(
        deps.llm,
        { history: routerHistory(history), message: input.text },
        log,
      );
      log.info({ route }, "message routed");
      if (route !== "agenda" && route !== "info" && route !== "outro")
        return { kind: "route", route };
    }

    const agenda = await deps.agendaFor(input.clinic.id);
    const profile = await deps.store.clinicProfile(input.clinic.id);
    if (!agenda || !profile) {
      log.warn("clinic has no agenda or profile configured");
      return { kind: "reply", text: AI_FALLBACK, handoff: "error" };
    }

    return await attend(input, { ...deps, logger: log }, agenda, profile, history, slotChoice?.[1]);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.name : "unknown" }, "attendant failed");
    return { kind: "reply", text: AI_FALLBACK, handoff: "error" };
  }
}

async function attend(
  input: AiInput,
  deps: OrchestratorDeps,
  agenda: AgendaProvider,
  profile: NonNullable<Awaited<ReturnType<ConversationStore["clinicProfile"]>>>,
  history: Awaited<ReturnType<ConversationStore["recentMessages"]>>,
  chosenOption: string | undefined,
): Promise<AiOutcome> {
  const { conv, now } = input;
  const tz = agenda.timeZone;
  const state = loadState(conv.agentState, now);
  const [procedures, hours] = await Promise.all([
    agenda.listarProcedimentos(),
    agenda.horariosDeAtendimento(),
  ]);

  const ctx: ToolContext = {
    agenda,
    profile,
    contact: conv.contact,
    patientId: conv.patientId,
    linkPatient: (patientId) => deps.store.updateConversation(conv.id, { patientId }),
    state,
    now,
    ...(deps.waitlist
      ? {
          waitlist: {
            join: (patientId: string, procedureId: string, until: Date) =>
              deps.waitlist!.join(input.clinic.id, patientId, procedureId, until),
          },
        }
      : {}),
    effects: {
      offersListed: false,
      allowedTimes: new Set([
        ...openingTimes(hours),
        ...state.offers.map((o) => formatTimePtBr(new Date(o.startsAt), tz)),
        ...state.appointments.map((a) => formatTimePtBr(new Date(a.startsAt), tz)),
      ]),
      allowedPrices: new Set(
        procedures.flatMap((p) => (p.priceCents === null ? [] : [p.priceCents])),
      ),
    },
  };

  const patient = conv.patientId ? null : await agenda.buscarPaciente({ phone: conv.contact });
  if (patient) {
    ctx.patientId = patient.id;
    await ctx.linkPatient(patient.id);
  }

  const messages = attendantMessages(history, input.text, chosenOption, state, tz);
  messages.push({
    role: "system",
    content: turnContext({
      now,
      tz,
      state,
      registered: ctx.patientId !== null,
      patientName: patient?.name,
    }),
  });

  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: attendantSystemPrompt(profile.name),
      cache_control: { type: "ephemeral" },
    },
  ];

  let finalText = "";
  const toolsUsed: string[] = [];
  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    const res = await deps.llm.create({
      model: MODELS.attendant,
      max_tokens: 8000,
      system,
      tools: TOOL_DEFINITIONS,
      messages,
      output_config: { effort: deps.effort ?? "medium" },
    });

    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
      deps.logger.warn({ stopReason: res.stop_reason }, "attendant stopped early");
      return { kind: "reply", text: AI_FALLBACK, handoff: "error" };
    }

    if (res.stop_reason !== "tool_use") {
      finalText = textOf(res);
      break;
    }

    // Append the assistant turn unchanged (thinking blocks included), then all results in one message.
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      toolsUsed.push(block.name);
      const { result, isError } = await runTool(block.name, block.input, ctx);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
        ...(isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }

  state.updatedAt = now.toISOString();
  await deps.store.updateConversation(conv.id, { agentState: state });
  deps.logger.info(
    { tools: toolsUsed, handoff: ctx.effects.handoff ?? null },
    "attendant turn done",
  );

  if (!finalText)
    return { kind: "reply", text: AI_FALLBACK, handoff: ctx.effects.handoff ?? "error" };

  const guard = checkReply(finalText, ctx.effects);
  if (!guard.ok) {
    deps.logger.warn({ reason: guard.reason }, "output guard blocked attendant reply");
    return { kind: "reply", text: AI_FALLBACK, handoff: "guard" };
  }

  const list =
    ctx.effects.offersListed && !ctx.effects.handoff && state.offers.length > 0
      ? offersList(state, tz)
      : undefined;
  return {
    kind: "reply",
    text: finalText,
    ...(list ? { list } : {}),
    ...(ctx.effects.handoff ? { handoff: ctx.effects.handoff } : {}),
  };
}

function routerHistory(history: Awaited<ReturnType<ConversationStore["recentMessages"]>>) {
  return history
    .filter((m) => m.body)
    .slice(-6)
    .map((m) => ({
      from: m.direction === "INBOUND" ? ("paciente" as const) : ("clinica" as const),
      text: m.body!,
    }));
}

/** Stored conversation (text only) as API messages; must start with the patient. */
function attendantMessages(
  history: Awaited<ReturnType<ConversationStore["recentMessages"]>>,
  text: string,
  chosenOption: string | undefined,
  state: AgentState,
  tz: string,
): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = [];
  const past = history.filter((m) => m.body);
  for (const m of past) {
    if (msgs.length === 0 && m.direction !== "INBOUND") continue;
    msgs.push(
      m.direction === "INBOUND"
        ? { role: "user", content: m.body! }
        : { role: "assistant", content: m.direction === "ECHO" ? `[recepção] ${m.body}` : m.body! },
    );
  }
  let current = text;
  if (chosenOption) {
    const offer = state.offers.find((o) => String(o.n) === chosenOption);
    current = offer
      ? `[escolheu na lista a opção ${offer.n}: ${offer.procedureName}, ${formatWhenPtBr(new Date(offer.startsAt), tz)}]`
      : `[escolheu na lista uma opção que já expirou: ${text}]`;
  }
  msgs.push({ role: "user", content: current });
  return msgs;
}

function turnContext(p: {
  now: Date;
  tz: string;
  state: AgentState;
  registered: boolean;
  patientName?: string;
}) {
  const offers = p.state.offers.length
    ? p.state.offers
        .map((o) => `${o.n}) ${o.procedureName}, ${formatWhenPtBr(new Date(o.startsAt), p.tz)}`)
        .join("; ")
    : "nenhuma";
  const appts = p.state.appointments.length
    ? p.state.appointments
        .map((a) => `${a.n}) ${a.procedureName}, ${formatWhenPtBr(new Date(a.startsAt), p.tz)}`)
        .join("; ")
    : "nenhuma listada";
  return [
    "Contexto desta mensagem (não mostre ao paciente):",
    `- Agora: ${formatWhenPtBr(p.now, p.tz)} (fuso da clínica). Data de hoje: ${new Intl.DateTimeFormat("en-CA", { timeZone: p.tz }).format(p.now)}.`,
    `- Paciente cadastrado: ${p.registered ? `sim${p.patientName ? `, ${p.patientName}` : ""}` : "não (peça o nome completo antes de reservar)"}.`,
    `- Opções de horário em aberto: ${offers}.`,
    `- Consultas numeradas: ${appts}.`,
  ].join("\n");
}

function offersList(state: AgentState, tz: string): ListMessage {
  const procedure = state.offers[0]!.procedureName;
  return {
    body: `Horários livres para ${procedure}. Toque em "Ver horários" e escolha um.`,
    button: "Ver horários",
    rows: state.offers.map((o) => ({
      id: `slot:${o.n}`,
      title: formatShortPtBr(new Date(o.startsAt), tz),
      description: o.procedureName.slice(0, 72),
    })),
  };
}
