import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { normalize } from "../conversation/intents.js";
import { formatCents } from "../lib/money.js";
import type { ClinicProfile } from "../conversation/store.js";
import {
  AppointmentNotFoundError,
  SlotUnavailableError,
  type AgendaProvider,
  type ProcedureInfo,
  type Slot,
} from "../scheduling/agenda-provider.js";
import {
  addDays,
  dateInZone,
  formatTimePtBr,
  formatWhenPtBr,
  minuteOfDayInZone,
  zonedToUtc,
} from "../scheduling/time.js";
import { describeUntil } from "../waitlist/waitlist.js";
import type { AgentState, Offer } from "./state.js";

export const HANDOFF_REASONS = [
  "pedido_do_paciente",
  "pergunta_clinica",
  "nao_entendi",
  "fora_do_escopo",
  "convenio",
  "reclamacao",
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** Everything a tool may touch. Bound to one clinic and one conversation by the orchestrator. */
export type ToolContext = {
  agenda: AgendaProvider;
  profile: ClinicProfile;
  /** Patient's normalized WhatsApp number (wa_id). */
  contact: string;
  patientId: string | null;
  linkPatient(patientId: string): Promise<void>;
  /** Mutated by tools; persisted after the turn. */
  state: AgentState;
  now: Date;
  effects: ToolEffects;
  /** Insurance plan and card of the patient. Absent = the front desk collects them. */
  insurance?: {
    register(
      patientId: string,
      plan: string,
      card: string,
    ): Promise<
      { plan: string } | { error: "plan"; plans: string[] } | { error: "card" | "patient" }
    >;
    requiresAuthorization(patientId: string, procedureId: string): Promise<boolean>;
  };
  /** Waiting list of this clinic. Absent = the front desk manages it. */
  waitlist?: {
    join(
      patientId: string,
      procedureId: string,
      until: Date,
    ): Promise<{ id: string; created: boolean } | null>;
  };
};

export type ToolEffects = {
  handoff?: HandoffReason;
  /** listar_horarios ran this turn: send the offers as a WhatsApp list after the reply. */
  offersListed: boolean;
  /** Clock times ("09:00") and prices (cents) the reply may mention. */
  allowedTimes: Set<string>;
  allowedPrices: Set<number>;
};

type ToolResult = Record<string, unknown>;

type ToolDef<S extends z.ZodType> = {
  description: string;
  input: S;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
};

const tool = <S extends z.ZodType>(def: ToolDef<S>) => def;

const MAX_OFFERS = 8;
const MAX_PER_DAY = 3;
const SEARCH_WINDOW_DAYS = 7;
const SEARCH_MAX_DAYS = 28;

export const TOOLS = {
  info_clinica: tool({
    description:
      "Dados da clínica: endereço, dias e horários de atendimento, procedimentos com duração e " +
      "preço particular (quando tabelado), convênios aceitos e formas de pagamento. Use antes de " +
      "responder qualquer dúvida sobre a clínica, preço ou convênio.",
    input: z.strictObject({}),
    async run(_input, ctx) {
      const [procedures, hours] = await Promise.all([
        ctx.agenda.listarProcedimentos(),
        ctx.agenda.horariosDeAtendimento(),
      ]);
      const { coverage, insurancePlans } = ctx.profile;
      const withTable = new Set(coverage.map((c) => c.plan));
      return {
        nome: ctx.profile.name,
        endereco: ctx.profile.address ?? "não cadastrado: peça para a recepção confirmar",
        horarios_de_atendimento: describeHours(hours),
        procedimentos: procedures.map((p) => ({
          nome: p.name,
          duracao_minutos: p.durationMinutes,
          preco_particular:
            p.priceCents === null ? "definido na avaliação" : formatCents(p.priceCents),
          coberto_pelos_convenios: coverage
            .filter((c) => c.procedureId === p.id)
            .map((c) => ({ convenio: c.plan, autorizacao_previa: c.requiresAuthorization })),
        })),
        convenios_aceitos: insurancePlans,
        convenios_sem_tabela_de_cobertura: insurancePlans.filter((n) => !withTable.has(n)),
        formas_de_pagamento: ["Pix", "boleto", "cartão de crédito"],
      };
    },
  }),

  listar_horarios: tool({
    description:
      "Busca horários livres na agenda para um procedimento. As opções encontradas são enviadas " +
      "ao paciente automaticamente numa lista do WhatsApp logo depois da sua resposta. Use o " +
      "número da opção (campo opcao) em reservar ou remarcar.",
    input: z.strictObject({
      procedimento: z
        .string()
        .min(2)
        .max(80)
        .describe("Nome do procedimento como aparece em info_clinica; na dúvida, Avaliação"),
      a_partir_de: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Data inicial AAAA-MM-DD no fuso da clínica; omita para começar hoje"),
      periodo: z.enum(["manha", "tarde", "qualquer"]).optional(),
    }),
    async run(input, ctx) {
      const procedures = await ctx.agenda.listarProcedimentos();
      const procedure = matchProcedure(procedures, input.procedimento);
      if (!procedure) {
        return {
          erro: "procedimento não encontrado",
          procedimentos_validos: procedures.map((p) => p.name),
        };
      }
      const tz = ctx.agenda.timeZone;
      const today = dateInZone(ctx.now, tz);
      let from = input.a_partir_de && input.a_partir_de > today ? input.a_partir_de : today;
      const period = input.periodo ?? "qualquer";

      let picked: Slot[] = [];
      for (let searched = 0; searched < SEARCH_MAX_DAYS && picked.length === 0; ) {
        const slots = await ctx.agenda.listarHorarios({
          procedureId: procedure.id,
          from,
          days: SEARCH_WINDOW_DAYS,
        });
        picked = spread(
          slots.filter((s) => inPeriod(s.startsAt, period, tz)),
          tz,
        );
        searched += SEARCH_WINDOW_DAYS;
        from = addDays(from, SEARCH_WINDOW_DAYS);
      }

      ctx.state.offers = picked.map((s, i) => ({
        n: i + 1,
        dentistId: s.dentistId,
        procedureId: s.procedureId,
        procedureName: procedure.name,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
      }));
      ctx.effects.offersListed = ctx.state.offers.length > 0;
      for (const s of picked) ctx.effects.allowedTimes.add(formatTimePtBr(s.startsAt, tz));

      if (picked.length === 0) {
        return {
          procedimento: procedure.name,
          opcoes: [],
          observacao: `Sem horários livres nas próximas ${SEARCH_MAX_DAYS / 7} semanas. Ofereça falar com a recepção.`,
        };
      }
      return {
        procedimento: procedure.name,
        duracao_minutos: procedure.durationMinutes,
        opcoes: ctx.state.offers.map((o) => ({
          opcao: o.n,
          quando: formatWhenPtBr(new Date(o.startsAt), tz),
        })),
        observacao:
          "A lista vai para o paciente logo após a sua mensagem: não repita todas as opções, " +
          "só convide a escolher uma.",
      };
    },
  }),

  reservar: tool({
    description:
      "Reserva uma das opções da última busca de listar_horarios. Só chame depois que o paciente " +
      "confirmar procedimento, dia e horário. Paciente sem cadastro precisa do nome completo.",
    input: z.strictObject({
      opcao: z.number().int().min(1).max(MAX_OFFERS),
      nome_completo: z
        .string()
        .min(3)
        .max(120)
        .optional()
        .describe("Nome completo do paciente, obrigatório no primeiro agendamento"),
    }),
    async run(input, ctx) {
      const offer = ctx.state.offers.find((o) => o.n === input.opcao);
      if (!offer) return { erro: "opção inexistente: busque horários de novo com listar_horarios" };

      const patient = await resolvePatient(ctx, input.nome_completo);
      if (!patient)
        return { erro: "paciente sem cadastro: pergunte o nome completo e tente de novo" };

      try {
        const { appointmentId } = await ctx.agenda.reservar({
          patientId: patient.id,
          slot: slotOf(offer),
        });
        ctx.state.offers = [];
        ctx.state.appointments = [];
        const tz = ctx.agenda.timeZone;
        ctx.effects.allowedTimes.add(formatTimePtBr(new Date(offer.startsAt), tz));
        const authorization = await ctx.insurance?.requiresAuthorization(
          patient.id,
          offer.procedureId,
        );
        return {
          ok: true,
          consulta_id: appointmentId,
          ...(authorization
            ? {
                autorizacao_previa:
                  "O convênio do paciente pede autorização para este procedimento: diga que a " +
                  "recepção pede a autorização e avisa o resultado por aqui antes da consulta.",
              }
            : {}),
          ...(patient.name ? { paciente: patient.name } : {}),
          procedimento: offer.procedureName,
          quando: formatWhenPtBr(new Date(offer.startsAt), tz),
          observacao: "A clínica manda lembrete antes da consulta para o paciente confirmar.",
        };
      } catch (err) {
        if (err instanceof SlotUnavailableError) {
          ctx.state.offers = ctx.state.offers.filter((o) => o.n !== offer.n);
          return { erro: "esse horário acabou de ser ocupado: ofereça as outras opções" };
        }
        throw err;
      }
    },
  }),

  minhas_consultas: tool({
    description:
      "Lista as próximas consultas do paciente desta conversa, numeradas. Use antes de remarcar " +
      "ou cancelar.",
    input: z.strictObject({}),
    async run(_input, ctx) {
      const patient = await resolvePatient(ctx);
      if (!patient) return { consultas: [] };
      const list = await ctx.agenda.consultasDoPaciente({ patientId: patient.id, from: ctx.now });
      const tz = ctx.agenda.timeZone;
      ctx.state.appointments = list.map((a, i) => ({
        n: i + 1,
        appointmentId: a.id,
        procedureName: a.procedureName,
        startsAt: a.startsAt.toISOString(),
      }));
      for (const a of list) ctx.effects.allowedTimes.add(formatTimePtBr(a.startsAt, tz));
      return {
        consultas: list.map((a, i) => ({
          consulta: i + 1,
          procedimento: a.procedureName,
          quando: formatWhenPtBr(a.startsAt, tz),
          situacao: a.status === "CONFIRMED" ? "confirmada" : "aguardando confirmação",
        })),
      };
    },
  }),

  remarcar: tool({
    description:
      "Move uma consulta (número de minhas_consultas) para uma opção de listar_horarios. Só chame " +
      "depois que o paciente confirmar o novo horário.",
    input: z.strictObject({
      consulta: z.number().int().min(1),
      opcao: z.number().int().min(1).max(MAX_OFFERS),
    }),
    async run(input, ctx) {
      const appt = ctx.state.appointments.find((a) => a.n === input.consulta);
      if (!appt) return { erro: "consulta inexistente: chame minhas_consultas primeiro" };
      const offer = ctx.state.offers.find((o) => o.n === input.opcao);
      if (!offer) return { erro: "opção inexistente: busque horários de novo com listar_horarios" };
      const patient = await resolvePatient(ctx);
      if (!patient) return { erro: "paciente sem cadastro" };
      try {
        await ctx.agenda.remarcar({
          appointmentId: appt.appointmentId,
          patientId: patient.id,
          slot: slotOf(offer),
        });
      } catch (err) {
        if (err instanceof SlotUnavailableError) {
          ctx.state.offers = ctx.state.offers.filter((o) => o.n !== offer.n);
          return { erro: "esse horário acabou de ser ocupado: ofereça as outras opções" };
        }
        if (err instanceof AppointmentNotFoundError) return { erro: "consulta não encontrada" };
        throw err;
      }
      ctx.state.offers = [];
      ctx.state.appointments = [];
      const tz = ctx.agenda.timeZone;
      ctx.effects.allowedTimes.add(formatTimePtBr(new Date(offer.startsAt), tz));
      return {
        ok: true,
        procedimento: offer.procedureName,
        antes: formatWhenPtBr(new Date(appt.startsAt), tz),
        agora: formatWhenPtBr(new Date(offer.startsAt), tz),
      };
    },
  }),

  cancelar: tool({
    description:
      "Cancela uma consulta (número de minhas_consultas). Só chame depois que o paciente " +
      "confirmar que quer cancelar.",
    input: z.strictObject({ consulta: z.number().int().min(1) }),
    async run(input, ctx) {
      const appt = ctx.state.appointments.find((a) => a.n === input.consulta);
      if (!appt) return { erro: "consulta inexistente: chame minhas_consultas primeiro" };
      const patient = await resolvePatient(ctx);
      if (!patient) return { erro: "paciente sem cadastro" };
      try {
        await ctx.agenda.cancelar({ appointmentId: appt.appointmentId, patientId: patient.id });
      } catch (err) {
        if (err instanceof AppointmentNotFoundError) return { erro: "consulta não encontrada" };
        throw err;
      }
      ctx.state.appointments = [];
      return {
        ok: true,
        procedimento: appt.procedureName,
        quando: formatWhenPtBr(new Date(appt.startsAt), ctx.agenda.timeZone),
      };
    },
  }),

  informar_convenio: tool({
    description:
      "Registra o convênio e o número da carteirinha do paciente. Chame quando o paciente disser " +
      "que vai usar um dos convênios aceitos (info_clinica), antes de reservar. A recepção usa a " +
      "carteirinha para pedir autorização ao convênio quando o procedimento exige.",
    input: z.strictObject({
      convenio: z.string().min(2).max(60).describe("Nome do convênio como em convenios_aceitos"),
      carteirinha: z
        .string()
        .min(5)
        .max(40)
        .describe("Número da carteirinha, como o paciente informou"),
      nome_completo: z
        .string()
        .min(3)
        .max(120)
        .optional()
        .describe("Nome completo do paciente, obrigatório se ele ainda não tem cadastro"),
    }),
    async run(input, ctx) {
      if (!ctx.insurance)
        return { erro: "registro de convênio indisponível: a recepção confere na consulta" };
      const patient = await resolvePatient(ctx, input.nome_completo);
      if (!patient)
        return { erro: "paciente sem cadastro: pergunte o nome completo e tente de novo" };
      const out = await ctx.insurance.register(patient.id, input.convenio, input.carteirinha);
      if ("plan" in out)
        return {
          ok: true,
          convenio: out.plan,
          observacao: "Não repita o número da carteirinha na resposta.",
        };
      if (out.error === "plan")
        return { erro: "convênio não aceito pela clínica", convenios_aceitos: out.plans };
      if (out.error === "card")
        return { erro: "carteirinha inválida: peça o número de novo, só letras e números" };
      return { erro: "não consegui registrar: transfira para a recepção" };
    },
  }),

  entrar_lista_espera: tool({
    description:
      "Coloca o paciente na lista de espera de um procedimento, quando ele quer um horário mais " +
      "cedo do que os livres. Se abrir uma vaga antes, a clínica avisa por aqui e o primeiro que " +
      "aceitar fica com ela. Só chame depois que o paciente disser que quer entrar na lista.",
    input: z.strictObject({
      procedimento: z.string().min(2).max(80),
      nome_completo: z
        .string()
        .min(3)
        .max(120)
        .optional()
        .describe("Nome completo do paciente, obrigatório se ele ainda não tem cadastro"),
    }),
    async run(input, ctx) {
      if (!ctx.waitlist) return { erro: "lista de espera indisponível: transfira para a recepção" };
      const procedures = await ctx.agenda.listarProcedimentos();
      const procedure = matchProcedure(procedures, input.procedimento);
      if (!procedure)
        return {
          erro: "procedimento não encontrado",
          procedimentos_validos: procedures.map((p) => p.name),
        };
      const patient = await resolvePatient(ctx, input.nome_completo);
      if (!patient)
        return { erro: "paciente sem cadastro: pergunte o nome completo e tente de novo" };

      // Waits for a slot on a day before both the first free one and the patient's own booking.
      const tz = ctx.agenda.timeZone;
      const today = dateInZone(ctx.now, tz);
      let firstFree: Date | undefined;
      for (let d = 0; d < SEARCH_MAX_DAYS && !firstFree; d += SEARCH_WINDOW_DAYS) {
        const slots = await ctx.agenda.listarHorarios({
          procedureId: procedure.id,
          from: addDays(today, d),
          days: SEARCH_WINDOW_DAYS,
        });
        firstFree = slots[0]?.startsAt;
      }
      const booked = (
        await ctx.agenda.consultasDoPaciente({ patientId: patient.id, from: ctx.now })
      )
        .filter((a) => a.procedureId === procedure.id && a.status !== "CANCELLED")
        .at(0)?.startsAt;
      const days = [firstFree, booked]
        .filter((x): x is Date => !!x)
        .map((x) => dateInZone(x, tz))
        .sort();
      const untilDay = days[0] ?? addDays(today, SEARCH_MAX_DAYS);
      if (untilDay <= addDays(today, 1))
        return {
          erro: "já há horário livre hoje ou amanhã: ofereça listar_horarios em vez da lista de espera",
        };
      const until = zonedToUtc(untilDay, 0, tz);
      const out = await ctx.waitlist.join(patient.id, procedure.id, until);
      if (!out) return { erro: "não consegui colocar na lista: transfira para a recepção" };
      return {
        ok: true,
        procedimento: procedure.name,
        ja_estava_na_lista: !out.created,
        avisamos_vagas_ate: describeUntil(until, tz),
        observacao:
          "Diga que, se abrir uma vaga até essa data, a clínica manda uma mensagem por aqui e o " +
          "primeiro que aceitar fica com o horário.",
      };
    },
  }),

  transferir_humano: tool({
    description:
      "Passa a conversa para a recepção e pausa o bot. Use em pergunta clínica, pedido do " +
      "paciente, reclamação, convênio que exige análise, ou quando não entender o pedido.",
    input: z.strictObject({ motivo: z.enum(HANDOFF_REASONS) }),
    async run(input, ctx) {
      ctx.effects.handoff = input.motivo;
      return {
        ok: true,
        observacao: "Avise em uma frase que a recepção vai responder por aqui. Não faça mais nada.",
      };
    },
  }),
} as const;

export type ToolName = keyof typeof TOOLS;

/** Tool list for the API, in a fixed order (keeps the prompt cache prefix stable). */
export const TOOL_DEFINITIONS: Anthropic.Tool[] = Object.entries(TOOLS).map(([name, def]) => {
  const schema = z.toJSONSchema(def.input) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name,
    description: def.description,
    input_schema: schema as Anthropic.Tool.InputSchema,
  };
});

/** Validates the model's input with Zod and runs the tool. Errors go back to the model. */
export async function runTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<{ result: ToolResult; isError: boolean }> {
  if (!(name in TOOLS))
    return { result: { erro: `ferramenta desconhecida: ${name}` }, isError: true };
  const def = TOOLS[name as ToolName] as ToolDef<z.ZodType>;
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    return {
      result: { erro: "entrada inválida", detalhes: parsed.error.issues.map((i) => i.message) },
      isError: true,
    };
  }
  const result = await def.run(parsed.data, ctx);
  return { result, isError: "erro" in result };
}

// ---------- helpers ----------

function slotOf(o: Offer): Slot {
  return {
    dentistId: o.dentistId,
    procedureId: o.procedureId,
    startsAt: new Date(o.startsAt),
    endsAt: new Date(o.endsAt),
  };
}

async function resolvePatient(ctx: ToolContext, name?: string) {
  if (ctx.patientId) return { id: ctx.patientId, name: name ?? "" };
  const found = await ctx.agenda.buscarPaciente({ phone: ctx.contact });
  const patient =
    found ?? (name ? await ctx.agenda.cadastrarPaciente({ name, phone: ctx.contact }) : null);
  if (patient) {
    ctx.patientId = patient.id;
    await ctx.linkPatient(patient.id);
  }
  return patient;
}

export function matchProcedure(procedures: ProcedureInfo[], query: string) {
  const q = normalize(query);
  const byName = procedures.map((p) => ({ p, n: normalize(p.name) }));
  return (
    byName.find((x) => x.n === q)?.p ??
    byName.find((x) => x.n.includes(q) || q.includes(x.n.replace(/\s*\(.*\)/, "")))?.p ??
    byName.find((x) => x.n.split(/[\s()]+/).some((w) => w.length > 3 && q.includes(w)))?.p
  );
}

function inPeriod(startsAt: Date, period: "manha" | "tarde" | "qualquer", tz: string) {
  if (period === "qualquer") return true;
  const minute = minuteOfDayInZone(startsAt, tz);
  return period === "manha" ? minute < 12 * 60 : minute >= 12 * 60;
}

/** Up to MAX_OFFERS slots, at most MAX_PER_DAY per day, spread across each day. */
function spread(slots: Slot[], tz: string): Slot[] {
  const byDay = new Map<string, Slot[]>();
  for (const s of slots) {
    const d = dateInZone(s.startsAt, tz);
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const out: Slot[] = [];
  for (const day of byDay.values()) {
    const take = Math.min(MAX_PER_DAY, day.length);
    const idx = new Set(
      Array.from({ length: take }, (_, k) => Math.floor((k * day.length) / take)),
    );
    for (const i of idx) if (out.length < MAX_OFFERS) out.push(day[i]!);
  }
  return out;
}

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

function describeHours(hours: Array<{ weekday: number; startMinute: number; endMinute: number }>) {
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const byDay = new Map<number, string[]>();
  for (const h of hours)
    byDay.set(h.weekday, [
      ...(byDay.get(h.weekday) ?? []),
      `${hhmm(h.startMinute)} às ${hhmm(h.endMinute)}`,
    ]);
  return [...byDay.entries()].map(([d, ranges]) => `${WEEKDAYS[d]}: ${ranges.join(" e ")}`);
}

/** Clock times of the opening hours, so the guard lets the reply mention them. */
export function openingTimes(hours: Array<{ startMinute: number; endMinute: number }>) {
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return hours.flatMap((h) => [hhmm(h.startMinute), hhmm(h.endMinute)]);
}
