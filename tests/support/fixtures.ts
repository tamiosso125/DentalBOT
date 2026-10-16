import type { LlmClient } from "../../src/ai/llm.js";
import type { HandlerDeps } from "../../src/conversation/handler.js";
import { InMemoryConversationStore } from "../../src/conversation/store.js";
import { silentLogger } from "../../src/lib/logger.js";
import { MockPaymentsGateway } from "../../src/payments/asaas.js";
import { OverdueNotices } from "../../src/payments/overdue-notices.js";
import { QuoteBillingService } from "../../src/quotes/quote-billing.js";
import { InMemoryQuoteRepository } from "../../src/quotes/quote-repository.js";
import { QuoteFollowUps } from "../../src/quotes/quote-follow-up.js";
import { QuoteService } from "../../src/quotes/quote-service.js";
import { AgendaService } from "../../src/scheduling/agenda-service.js";
import { StaffAgenda } from "../../src/scheduling/staff-agenda.js";
import {
  AppointmentReminders,
  InMemoryAppointmentReminderRepository,
} from "../../src/scheduling/appointment-reminders.js";
import { InMemoryRecallRepository } from "../../src/recall/memory-recall.js";
import { RecallService } from "../../src/recall/recall.js";
import {
  InMemoryNoShowFollowUpRepository,
  NoShowFollowUps,
} from "../../src/scheduling/no-show-follow-up.js";
import { InsuranceAuthorizations } from "../../src/insurance/authorizations.js";
import { InMemoryInsuranceRepository } from "../../src/insurance/memory-insurance.js";
import { InMemorySurveyRepository } from "../../src/survey/memory-survey.js";
import { AftercareService } from "../../src/aftercare/aftercare.js";
import { InMemoryAftercareRepository } from "../../src/aftercare/memory-aftercare.js";
import { SurveyService } from "../../src/survey/survey.js";
import { InMemoryWaitlistRepository } from "../../src/waitlist/memory-waitlist.js";
import { WaitlistService } from "../../src/waitlist/waitlist.js";
import { demoAgendaSeed, InMemoryAgendaRepository } from "../../src/scheduling/memory-agenda.js";
import {
  fakeAppEcho,
  fakeButtonReply,
  fakeListReply,
  fakeTextMessage,
  SandboxChannel,
  signBody,
} from "../../src/whatsapp/index.js";

export const PHONE_NUMBER_ID = "100000000000001";
/** Fictitious test number (convention: 55 + DDD + 90000-XXXX). */
export const PATIENT = "5511900000001";

export const OTHER_PATIENT = "5511900000002";

export const CLINIC_ID = "clinic_test";

/**
 * Test graph: in-memory stores, sandbox channel and a fixed clock (Monday 2026-10-19,
 * 09:00 in São Paulo). Pass `llm` to turn the orchestrator on.
 */
/** Care instructions registered for the extraction (fictitious text). */
export const EXTRACTION_CARE =
  "Morda a gaze por 30 minutos.\nNas primeiras 24 horas, não cuspa nem faça bochecho.\nPrefira alimentos frios e pastosos.";

const COVERAGE = [
  { plan: "Odontoprev", procedureId: "proc_avaliacao", requiresAuthorization: false },
  { plan: "Odontoprev", procedureId: "proc_limpeza", requiresAuthorization: false },
  { plan: "Odontoprev", procedureId: "proc_extracao", requiresAuthorization: true },
];

export function makeDeps(
  opts: {
    now?: Date;
    llm?: LlmClient;
    /** null = no CPF on file. */ patientCpf?: string | null;
  } = {},
) {
  const store = new InMemoryConversationStore({
    id: CLINIC_ID,
    name: "Clínica Sorriso",
    phoneNumberId: PHONE_NUMBER_ID,
    address: "Rua Exemplo, 123 - São Paulo",
    insurancePlans: ["Odontoprev"],
    coverage: COVERAGE,
  });
  const channel = new SandboxChannel();
  const clock = { now: opts.now ?? new Date("2026-10-19T12:00:00Z") };
  const agendaRepo = new InMemoryAgendaRepository(demoAgendaSeed(CLINIC_ID), () => clock.now);
  const agenda = new AgendaService(agendaRepo, { now: () => clock.now });
  const seed = demoAgendaSeed(CLINIC_ID);
  const quoteRepo = new InMemoryQuoteRepository({
    clinic: {
      id: CLINIC_ID,
      name: "Clínica Sorriso",
      address: "Rua Exemplo, 123 - São Paulo",
      timeZone: "America/Sao_Paulo",
    },
    dentists: [{ id: "dentist_dev", name: "Dra. Exemplo", cro: "CRO-SP 00000" }],
    patients: [
      // Fictitious CPF from the test convention.
      {
        id: "patient_dev",
        name: "Maria Exemplo",
        phone: PATIENT,
        cpf: opts.patientCpf === undefined ? "52998224725" : opts.patientCpf,
      },
      { id: "patient_other", name: "João Exemplo", phone: OTHER_PATIENT },
    ],
    procedures: seed.procedures,
  });
  const payments = new MockPaymentsGateway();
  const quotes = new QuoteService({
    repo: quoteRepo,
    channel,
    store,
    logger: silentLogger,
    billing: new QuoteBillingService({ repo: quoteRepo, gateway: payments, logger: silentLogger }),
    now: () => clock.now,
  });
  const quoteFollowUps = new QuoteFollowUps({
    repo: quoteRepo,
    channel,
    store,
    logger: silentLogger,
  });
  const overdueNotices = new OverdueNotices({
    repo: quoteRepo,
    gateway: payments,
    channel,
    store,
    logger: silentLogger,
  });
  const agendaFor = async (clinicId: string) => (clinicId === CLINIC_ID ? agenda : null);
  const appointmentReminders = new AppointmentReminders({
    repo: new InMemoryAppointmentReminderRepository(agendaRepo, "Clínica Sorriso"),
    channel,
    store,
    logger: silentLogger,
  });
  const noShowFollowUps = new NoShowFollowUps({
    repo: new InMemoryNoShowFollowUpRepository(agendaRepo, "Clínica Sorriso"),
    channel,
    store,
    logger: silentLogger,
  });
  const recallRepo = new InMemoryRecallRepository(agendaRepo, store, "Clínica Sorriso");
  const recall = new RecallService({ repo: recallRepo, channel, store, logger: silentLogger });
  const waitlistRepo = new InMemoryWaitlistRepository(
    agendaRepo,
    "Clínica Sorriso",
    () => clock.now,
  );
  const waitlist = new WaitlistService({
    repo: waitlistRepo,
    agendaFor,
    channel,
    store,
    logger: silentLogger,
  });
  const insuranceRepo = new InMemoryInsuranceRepository(
    agendaRepo,
    "Clínica Sorriso",
    ["Odontoprev"],
    COVERAGE,
  );
  const insurance = new InsuranceAuthorizations({
    repo: insuranceRepo,
    channel,
    store,
    logger: silentLogger,
  });
  const aftercareRepo = new InMemoryAftercareRepository(
    agendaRepo,
    "Clínica Sorriso",
    new Map([["proc_extracao", EXTRACTION_CARE]]),
  );
  const aftercare = new AftercareService({
    repo: aftercareRepo,
    channel,
    store,
    logger: silentLogger,
  });
  // As in the database: the rating waits for "Tudo bem" on the post-procedure check-in.
  const surveyRepo = new InMemorySurveyRepository(agendaRepo, "Clínica Sorriso", (id) =>
    aftercareRepo.followUps.some((f) => f.appointmentId === id && f.answer !== "OK"),
  );
  const survey = new SurveyService({ repo: surveyRepo, channel, store, logger: silentLogger });
  const staffAgenda = new StaffAgenda({
    open: async (clinicId) =>
      clinicId === CLINIC_ID
        ? {
            agenda: new AgendaService(agendaRepo, { now: () => clock.now, minNoticeMinutes: 0 }),
            repo: agendaRepo,
            clinicName: "Clínica Sorriso",
          }
        : null,
    channel,
    store,
    logger: silentLogger,
    now: () => clock.now,
  });
  const deps: HandlerDeps = {
    store,
    channel,
    logger: silentLogger,
    now: () => clock.now,
    quotes,
    agendaFor,
    recall: recallRepo,
    waitlist,
    survey,
    aftercare,
    insurance,
    config: { handoffPauseMinutes: 240, privacyPolicyUrl: "https://example.com/privacidade" },
    ...(opts.llm
      ? {
          ai: {
            llm: opts.llm,
            store,
            agendaFor,
            logger: silentLogger,
            waitlist,
            insurance,
          },
        }
      : {}),
  };
  return {
    store,
    channel,
    clock,
    deps,
    agenda,
    agendaRepo,
    appointmentReminders,
    noShowFollowUps,
    recall,
    recallRepo,
    waitlist,
    waitlistRepo,
    survey,
    surveyRepo,
    aftercare,
    aftercareRepo,
    insurance,
    insuranceRepo,
    staffAgenda,
    quotes,
    quoteRepo,
    quoteFollowUps,
    overdueNotices,
    payments,
  };
}

export const textPayload = (text: string, from = PATIENT) =>
  fakeTextMessage({ phoneNumberId: PHONE_NUMBER_ID, from, text });

export const buttonPayload = (replyId: string, title: string, from = PATIENT) =>
  fakeButtonReply({ phoneNumberId: PHONE_NUMBER_ID, from, replyId, title });

export const listPayload = (replyId: string, title: string, from = PATIENT) =>
  fakeListReply({ phoneNumberId: PHONE_NUMBER_ID, from, replyId, title });

export const echoPayload = (text: string, to = PATIENT) =>
  fakeAppEcho({ phoneNumberId: PHONE_NUMBER_ID, to, text });

export function signed(payload: unknown, secret: string) {
  const body = JSON.stringify(payload);
  return { body, signature: signBody(body, secret) };
}
