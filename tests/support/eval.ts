import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { AnthropicLlm, type LlmClient } from "../../src/ai/llm.js";
import { ScriptedLlm } from "../../src/ai/scripted-llm.js";
import { handleWhatsAppEvent } from "../../src/conversation/handler.js";
import { normalize } from "../../src/conversation/intents.js";
import { zonedToUtc } from "../../src/scheduling/time.js";
import { normalizeWebhook, previewText } from "../../src/whatsapp/index.js";
import {
  buttonPayload,
  CLINIC_ID,
  echoPayload,
  listPayload,
  makeDeps,
  OTHER_PATIENT,
  PATIENT,
  textPayload,
} from "./fixtures.js";

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
    /** Status of the last appointment booked. */
    appointment_status: z
      .enum(["PENDING_CONFIRMATION", "CONFIRMED", "CANCELLED", "NO_SHOW", "COMPLETED"])
      .optional(),
    /** true = the bot sent a list of time slots in this step. */
    list: z.boolean().optional(),
    /** true = the quote PDF went out in this step. */
    document: z.boolean().optional(),
    /** Status of the last quote after this step. */
    quote_status: z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]).optional(),
    /** Installments recorded for the last quote. */
    installments: z.number().int().nonnegative().optional(),
    /** Asaas charges created so far (one per installment of an approved quote). */
    charges: z.number().int().nonnegative().optional(),
    /** How the clinic's quote went out: inside the 24h window or by template. */
    sent_via: z.enum(["session", "template"]).optional(),
    /** Status of the patient's last waiting-list entry. */
    waitlist_status: z.enum(["WAITING", "BOOKED", "REMOVED", "EXPIRED"]).optional(),
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
  /** The dentist creates and sends a quote (staff API) to the case's patient. */
  z
    .object({
      clinic_sends_quote: z
        .object({
          items: z.array(z.record(z.string(), z.unknown())).min(1),
          installmentCount: z.number().int().optional(),
          validDays: z.number().int().optional(),
          notes: z.string().optional(),
        })
        .strict(),
      expect: expectation.optional(),
    })
    .strict(),
  z.object({ advance_minutes: z.number().int().positive() }).strict(),
  /** The front desk books an appointment for the case's patient ("YYYY-MM-DDTHH:MM", clinic time). */
  z
    .object({
      clinic_books: z
        .object({
          procedureId: z.string(),
          at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
        })
        .strict(),
      expect: expectation.optional(),
    })
    .strict(),
  /** The hourly job that sends tomorrow's appointment reminders runs now. */
  z.object({ run_reminders: z.literal(true), expect: expectation.optional() }).strict(),
  /** The case's patient came to an appointment in the past ("YYYY-MM-DDTHH:MM", clinic time). */
  z
    .object({
      past_visit: z
        .object({
          procedureId: z.string(),
          at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
        })
        .strict(),
    })
    .strict(),
  /** The front desk records (true) or withdraws (false) the patient's recall consent. */
  z.object({ clinic_records_consent: z.boolean() }).strict(),
  /** The job that sends recall invitations (convite_retorno) runs now. */
  z.object({ run_recall: z.literal(true), expect: expectation.optional() }).strict(),
  /** The dentist's time is blocked ("YYYY-MM-DDTHH:MM", clinic time, end exclusive). */
  z
    .object({
      clinic_blocks: z
        .array(
          z
            .object({
              from: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
              to: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  /** Another patient (João) books ("YYYY-MM-DDTHH:MM", clinic time) or cancels his last booking. */
  z
    .object({
      other_patient_books: z
        .object({
          procedureId: z.string(),
          at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
        })
        .strict(),
    })
    .strict(),
  z.object({ other_patient_cancels: z.literal(true) }).strict(),
  /** The front desk puts the case's patient on the waiting list until a day (inclusive). */
  z
    .object({
      clinic_waitlists: z
        .object({ procedureId: z.string(), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
        .strict(),
    })
    .strict(),
  /** The job that offers freed slots to the waiting list (vaga_disponivel) runs now. */
  z.object({ run_waitlist: z.literal(true), expect: expectation.optional() }).strict(),
  /** The job that reminds about unanswered quotes (lembrete_orcamento) and expires them runs now. */
  z.object({ run_quote_follow_up: z.literal(true), expect: expectation.optional() }).strict(),
  /** The hourly job that sends the overdue installment notice (parcela_vencida) runs now. */
  z.object({ run_overdue_notices: z.literal(true), expect: expectation.optional() }).strict(),
  /** The front desk marks the patient's last appointment "Compareceu" (true) or "Faltou" (false). */
  z.object({ clinic_marks_attendance: z.boolean() }).strict(),
  /** The job that sends the satisfaction survey (pesquisa_satisfacao) runs now. */
  z.object({ run_survey: z.literal(true), expect: expectation.optional() }).strict(),
  /** The patient pays the last quote's installment N in Asaas (the webhook has not arrived). */
  z.object({ patient_pays_in_asaas: z.number().int().positive() }).strict(),
]);

export const caseSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    /** critical cases block deploys (alarm signs, privacy, clinical questions). */
    critical: z.boolean().default(false),
    /** true = the Claude orchestrator is on (scripted offline, real models with --live). */
    ai: z.boolean().default(false),
    /** false = the case's patient has no CPF on file (Asaas cannot bill without one). */
    patient_cpf: z.boolean().default(true),
    /** true = every Asaas call fails, as if Asaas were down. */
    asaas_down: z.boolean().default(false),
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

type Step = ConversationCase["steps"][number];
type Expectation = z.infer<typeof expectation>;

export async function runCase(
  file: string,
  c: ConversationCase,
  opts: RunOptions = {},
): Promise<CaseResult> {
  const scripted = c.ai && !opts.live ? new ScriptedLlm() : undefined;
  const llm: LlmClient | undefined = c.ai ? (scripted ?? new AnthropicLlm()) : undefined;
  const {
    deps,
    channel,
    store,
    clock,
    agenda,
    agendaRepo,
    appointmentReminders,
    recall,
    recallRepo,
    waitlist,
    waitlistRepo,
    survey,
    surveyRepo,
    staffAgenda,
    quotes,
    quoteRepo,
    quoteFollowUps,
    overdueNotices,
    payments,
  } = makeDeps({
    llm,
    patientCpf: c.patient_cpf ? undefined : null,
  });
  if (c.asaas_down) {
    const down = async () => {
      throw new Error("Asaas unavailable (eval)");
    };
    Object.assign(payments, {
      createCustomer: down,
      findCustomer: down,
      createCharge: down,
      findCharge: down,
    });
  }
  const failures: string[] = [];
  /** Button ids may say "{quote}" for the id of the last quote the clinic sent. */
  let quoteId = "";
  let sentVia: string | undefined;

  for (const [i, s] of c.steps.entries()) {
    if ("advance_minutes" in s) {
      clock.now = new Date(clock.now.getTime() + s.advance_minutes * 60_000);
      continue;
    }
    const where = `passo ${i + 1}`;
    const before = channel.outbox.length;
    if ("clinic_sends_quote" in s) {
      const created = await quotes.create(CLINIC_ID, {
        patientId: "patient_dev",
        dentistId: "dentist_dev",
        ...s.clinic_sends_quote,
      });
      quoteId = created.id;
      sentVia = (await quotes.send(CLINIC_ID, quoteId)).via;
    } else if ("clinic_books" in s) {
      await book(s.clinic_books);
    } else if ("run_reminders" in s) {
      await appointmentReminders.run(clock.now);
    } else if ("past_visit" in s) {
      await pastVisit(s.past_visit);
      continue;
    } else if ("clinic_records_consent" in s) {
      const patient = await patientOfCase();
      await recallRepo.recordConsent(CLINIC_ID, patient.id, s.clinic_records_consent, clock.now);
      continue;
    } else if ("run_recall" in s) {
      await recall.run(clock.now);
    } else if ("clinic_blocks" in s) {
      for (const b of s.clinic_blocks)
        agendaRepo.addBlock({
          dentistId: "dentist_dev",
          startsAt: localTime(b.from),
          endsAt: localTime(b.to),
        });
      continue;
    } else if ("other_patient_books" in s) {
      await book(s.other_patient_books, await otherPatient());
      continue;
    } else if ("other_patient_cancels" in s) {
      const other = await otherPatient();
      const last = agendaRepo.appointments.filter(
        (a) => a.patientId === other.id && a.status !== "CANCELLED",
      );
      await agendaRepo.cancelAppointment(last.at(-1)!.id);
      continue;
    } else if ("clinic_waitlists" in s) {
      const patient = await patientOfCase();
      await waitlist.add(CLINIC_ID, { patientId: patient.id, ...s.clinic_waitlists }, clock.now);
      continue;
    } else if ("run_waitlist" in s) {
      await waitlist.run(clock.now);
    } else if ("run_quote_follow_up" in s) {
      await quoteFollowUps.run(clock.now);
    } else if ("run_overdue_notices" in s) {
      await overdueNotices.run(clock.now);
    } else if ("clinic_marks_attendance" in s) {
      const patient = await patientOfCase();
      const last = agendaRepo.appointments.filter((a) => a.patientId === patient.id).at(-1);
      if (!last) throw new Error("paciente sem consulta para marcar comparecimento");
      await staffAgenda.attendance(CLINIC_ID, last.id, { attended: s.clinic_marks_attendance });
      continue;
    } else if ("run_survey" in s) {
      await survey.run(clock.now);
    } else if ("patient_pays_in_asaas" in s) {
      const inst = quoteRepo.quotes
        .find((q) => q.id === quoteId)
        ?.installments.find((i) => i.number === s.patient_pays_in_asaas);
      const charge = payments.charges.find((c) => c.externalReference === inst?.id);
      if (!charge) throw new Error(`parcela ${s.patient_pays_in_asaas} sem cobrança`);
      charge.status = "RECEIVED";
      continue;
    } else {
      await deliver(s, where);
    }
    if ("reception" in s || !s.expect) continue;
    check(s.expect, where, before);
  }
  return { file, name: c.name, critical: c.critical, failures };

  async function patientOfCase() {
    return (
      (await agenda.buscarPaciente({ phone: PATIENT })) ??
      (await agenda.cadastrarPaciente({ name: "Maria Exemplo", phone: PATIENT }))
    );
  }

  async function otherPatient() {
    return (
      (await agenda.buscarPaciente({ phone: OTHER_PATIENT })) ??
      (await agenda.cadastrarPaciente({ name: "João Exemplo", phone: OTHER_PATIENT }))
    );
  }

  function localTime(at: string) {
    const [date, time] = at.split("T") as [string, string];
    const [h, m] = time.split(":").map(Number) as [number, number];
    return zonedToUtc(date, h * 60 + m, agenda.timeZone);
  }

  async function at(input: { procedureId: string; at: string }) {
    const procedure = (await agenda.listarProcedimentos()).find((p) => p.id === input.procedureId);
    if (!procedure) throw new Error(`procedimento ${input.procedureId} não existe`);
    return { procedure, startsAt: localTime(input.at) };
  }

  /** Written straight into the agenda: booking rules do not allow dates in the past. */
  async function pastVisit(input: { procedureId: string; at: string }) {
    const { procedure, startsAt } = await at(input);
    const patient = await patientOfCase();
    agendaRepo.appointments.push({
      id: `appt_past_${agendaRepo.appointments.length}`,
      patientId: patient.id,
      dentistId: "dentist_dev",
      procedureId: procedure.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + procedure.durationMinutes * 60_000),
      status: "COMPLETED",
      reminderSentAt: null,
    });
  }

  async function book(input: { procedureId: string; at: string }, who?: { id: string }) {
    const { procedure, startsAt } = await at(input);
    const patient = who ?? (await patientOfCase());
    await agenda.reservar({
      patientId: patient.id,
      slot: {
        dentistId: "dentist_dev",
        procedureId: procedure.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + procedure.durationMinutes * 60_000),
      },
    });
  }

  async function deliver(
    s: Extract<
      Step,
      { patient: string } | { button: string } | { list: string } | { reception: string }
    >,
    where: string,
  ) {
    /**
     * "{appointment}" in a button id is the last appointment in the agenda; "{offer}" the last
     * waiting-list offer; "{survey}" the last satisfaction survey.
     */
    const appointmentId = agendaRepo.appointments.at(-1)?.id ?? "";
    const offerId = waitlistRepo.offers.at(-1)?.id ?? "";
    const surveyId = surveyRepo.surveys.at(-1)?.id ?? "";
    const payload =
      "patient" in s
        ? textPayload(s.patient)
        : "button" in s
          ? buttonPayload(
              s.button
                .replace("{quote}", quoteId)
                .replace("{appointment}", appointmentId)
                .replace("{offer}", offerId)
                .replace("{survey}", surveyId),
              s.title,
            )
          : "list" in s
            ? listPayload(s.list, s.title)
            : echoPayload(s.reception);
    if (scripted && "model" in s && s.model) {
      if (s.model.route) scripted.route(s.model.route);
      scripted.push(...s.model.replies);
    }
    for (const e of normalizeWebhook(payload)) await handleWhatsAppEvent(e, deps);
    if (scripted && scripted.pending > 0) {
      failures.push(`${where}: ${scripted.pending} resposta(s) do modelo roteirizado não usada(s)`);
      scripted.clear();
    }
  }

  function check(expect: Expectation, where: string, before: number) {
    const sent = channel.outbox.slice(before);
    const replies = sent.map(previewText);
    const reply = normalize(replies.join("\n"));
    for (const want of expect.contains) {
      if (!reply.includes(normalize(want)))
        failures.push(`${where}: resposta não contém "${want}"`);
    }
    for (const bad of expect.not_contains) {
      if (reply.includes(normalize(bad))) failures.push(`${where}: resposta contém "${bad}"`);
    }
    if (expect.silent === true && replies.length > 0)
      failures.push(`${where}: bot respondeu, devia ficar em silêncio`);
    if (expect.silent === false && replies.length === 0)
      failures.push(`${where}: bot não respondeu`);
    if (expect.list !== undefined && sent.some((m) => m.kind === "list") !== expect.list)
      failures.push(`${where}: lista de horários esperada ${expect.list}`);
    if (expect.appointments !== undefined) {
      const active = agendaRepo.appointments.filter((a) => a.status !== "CANCELLED").length;
      if (active !== expect.appointments)
        failures.push(`${where}: ${active} consulta(s) na agenda, esperado ${expect.appointments}`);
    }
    const appointment = agendaRepo.appointments.at(-1);
    if (
      expect.appointment_status !== undefined &&
      appointment?.status !== expect.appointment_status
    )
      failures.push(
        `${where}: consulta ${appointment?.status ?? "inexistente"}, esperado ${expect.appointment_status}`,
      );
    if (expect.handoff !== undefined) {
      const conv = [...store.conversations.values()][0];
      const paused = !!conv?.botPausedUntil && conv.botPausedUntil > clock.now;
      if (paused !== expect.handoff)
        failures.push(`${where}: handoff esperado ${expect.handoff}, obtido ${paused}`);
    }
    const quote = quoteRepo.quotes.find((q) => q.id === quoteId);
    if (expect.quote_status !== undefined && quote?.status !== expect.quote_status)
      failures.push(
        `${where}: orçamento ${quote?.status ?? "inexistente"}, esperado ${expect.quote_status}`,
      );
    if (
      expect.installments !== undefined &&
      (quote?.installments.length ?? 0) !== expect.installments
    )
      failures.push(
        `${where}: ${quote?.installments.length ?? 0} parcela(s), esperado ${expect.installments}`,
      );
    if (expect.charges !== undefined && payments.charges.length !== expect.charges)
      failures.push(
        `${where}: ${payments.charges.length} cobrança(s) no Asaas, esperado ${expect.charges}`,
      );
    if (expect.sent_via !== undefined && sentVia !== expect.sent_via)
      failures.push(`${where}: orçamento enviado por ${sentVia}, esperado ${expect.sent_via}`);
    const entry = waitlistRepo.entries.at(-1);
    if (expect.waitlist_status !== undefined && entry?.status !== expect.waitlist_status)
      failures.push(
        `${where}: lista de espera ${entry?.status ?? "vazia"}, esperado ${expect.waitlist_status}`,
      );
    if (
      expect.document !== undefined &&
      sent.some((m) => m.kind === "document") !== expect.document
    )
      failures.push(`${where}: PDF do orçamento esperado ${expect.document}`);
  }
}
