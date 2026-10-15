import type { LlmClient } from "../../src/ai/llm.js";
import type { HandlerDeps } from "../../src/conversation/handler.js";
import { InMemoryConversationStore } from "../../src/conversation/store.js";
import { silentLogger } from "../../src/lib/logger.js";
import { MockPaymentsGateway } from "../../src/payments/asaas.js";
import { QuoteBillingService } from "../../src/quotes/quote-billing.js";
import { InMemoryQuoteRepository } from "../../src/quotes/quote-repository.js";
import { QuoteService } from "../../src/quotes/quote-service.js";
import { AgendaService } from "../../src/scheduling/agenda-service.js";
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
  });
  const channel = new SandboxChannel();
  const clock = { now: opts.now ?? new Date("2026-10-19T12:00:00Z") };
  const agendaRepo = new InMemoryAgendaRepository(demoAgendaSeed(CLINIC_ID));
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
  const deps: HandlerDeps = {
    store,
    channel,
    logger: silentLogger,
    now: () => clock.now,
    quotes,
    config: { handoffPauseMinutes: 240, privacyPolicyUrl: "https://example.com/privacidade" },
    ...(opts.llm
      ? {
          ai: {
            llm: opts.llm,
            store,
            agendaFor: async (clinicId: string) => (clinicId === CLINIC_ID ? agenda : null),
            logger: silentLogger,
          },
        }
      : {}),
  };
  return { store, channel, clock, deps, agenda, agendaRepo, quotes, quoteRepo, payments };
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
