import { describe, expect, it } from "vitest";
import {
  buttonPayload,
  CLINIC_ID,
  echoPayload,
  makeDeps,
  OTHER_PATIENT,
  PATIENT,
} from "../../tests/support/fixtures.js";
import { handleWhatsAppEvent } from "../conversation/handler.js";
import { detectIntent } from "../conversation/intents.js";
import { silentLogger } from "../lib/logger.js";
import { normalizeWebhook, type WebhookPayload } from "../whatsapp/index.js";
import { InMemoryRecallRepository } from "./memory-recall.js";
import { recallCutoff, RecallError, RecallService, recallStatus } from "./recall.js";

const at = (iso: string) => new Date(iso);
/** Tuesday 20/10, 10:00 in São Paulo: inside the weekly window. */
const TUESDAY = at("2026-10-20T13:00:00Z");

/** Maria had a cleaning in March; João an evaluation in September. */
async function setup() {
  const ctx = makeDeps();
  const maria = await ctx.agenda.cadastrarPaciente({ name: "Maria Exemplo", phone: PATIENT });
  const joao = await ctx.agenda.cadastrarPaciente({ name: "João Exemplo", phone: OTHER_PATIENT });
  const visit = (patientId: string, procedureId: string, startsAt: string) =>
    ctx.agendaRepo.appointments.push({
      id: `appt_${ctx.agendaRepo.appointments.length}`,
      patientId,
      dentistId: "dentist_dev",
      procedureId,
      startsAt: at(startsAt),
      endsAt: new Date(at(startsAt).getTime() + 45 * 60_000),
      status: "COMPLETED",
      reminderSentAt: null,
    });
  visit(maria.id, "proc_limpeza", "2026-03-10T13:00:00Z");
  visit(joao.id, "proc_avaliacao", "2026-09-01T13:00:00Z");
  const consent = (patientId: string, granted = true, when = "2026-10-01T12:00:00Z") =>
    ctx.recallRepo.recordConsent(CLINIC_ID, patientId, granted, at(when));
  return { ctx, maria, joao, visit, consent };
}

async function deliver(payload: WebhookPayload, deps: ReturnType<typeof makeDeps>["deps"]) {
  for (const e of normalizeWebhook(payload)) await handleWhatsAppEvent(e, deps);
}

describe("recallStatus / recallCutoff", () => {
  const visit = at("2026-03-10T13:00:00Z");
  const yes = { granted: true, at: at("2026-04-01T12:00:00Z") };

  it("needs a granted consent and a later PARAR wins over it", () => {
    const row = { lastVisitAt: visit, consent: yes, optedOutAt: null, invitedAt: null };
    expect(recallStatus(row)).toBe("due");
    expect(recallStatus({ ...row, consent: null })).toBe("no_consent");
    expect(recallStatus({ ...row, consent: { ...yes, granted: false } })).toBe("no_consent");
    expect(recallStatus({ ...row, optedOutAt: at("2026-05-01T12:00:00Z") })).toBe("opted_out");
    // PARAR before the consent: the patient asked again later.
    expect(recallStatus({ ...row, optedOutAt: at("2026-03-01T12:00:00Z") })).toBe("due");
  });

  it("invites once per last visit", () => {
    const row = { lastVisitAt: visit, consent: yes, optedOutAt: null };
    expect(recallStatus({ ...row, invitedAt: at("2026-09-15T13:00:00Z") })).toBe("invited");
    expect(recallStatus({ ...row, invitedAt: at("2025-09-15T13:00:00Z") })).toBe("due");
  });

  it("counts calendar months at the clinic's midnight, clamping short months", () => {
    const tz = "America/Sao_Paulo";
    expect(recallCutoff(TUESDAY, tz, 6).toISOString()).toBe("2026-04-20T03:00:00.000Z");
    expect(recallCutoff(at("2026-08-31T15:00:00Z"), tz, 6).toISOString()).toBe(
      "2026-02-28T03:00:00.000Z",
    );
    expect(recallCutoff(at("2026-03-15T15:00:00Z"), tz, 6).toISOString()).toBe(
      "2025-09-15T03:00:00.000Z",
    );
  });
});

describe("RecallService.run", () => {
  it("invites due patients with consent, on Tuesday morning, once", async () => {
    const { ctx, maria, joao, consent } = await setup();
    await consent(maria.id);
    await consent(joao.id); // visited in September: not due yet

    expect(await ctx.recall.run(at("2026-10-19T13:00:00Z"))).toEqual({ sent: 0 }); // Monday
    expect(await ctx.recall.run(at("2026-10-20T11:00:00Z"))).toEqual({ sent: 0 }); // 08:00
    expect(await ctx.recall.run(at("2026-10-20T15:00:00Z"))).toEqual({ sent: 0 }); // 12:00
    expect(await ctx.recall.run(TUESDAY)).toEqual({ sent: 1 });
    expect(ctx.channel.outbox).toMatchObject([
      {
        kind: "template",
        to: PATIENT,
        template: "convite_retorno",
        params: ["Maria", "Clínica Sorriso"],
        buttonPayloads: ["recall:schedule", "recall:stop"],
      },
    ]);
    expect(ctx.store.messages).toHaveLength(1);
    expect(await ctx.recall.run(at("2026-10-27T13:00:00Z"))).toEqual({ sent: 0 });
  });

  it("skips patients with something booked, without consent or who opted out", async () => {
    const { ctx, maria, joao, visit, consent } = await setup();
    visit(joao.id, "proc_avaliacao", "2026-01-05T13:00:00Z");
    ctx.agendaRepo.appointments.at(-2)!.status = "CANCELLED"; // João's September visit
    expect(await ctx.recall.run(TUESDAY)).toEqual({ sent: 0 });

    await consent(maria.id);
    await consent(joao.id);
    visit(maria.id, "proc_limpeza", "2026-11-10T13:00:00Z");
    ctx.agendaRepo.appointments.at(-1)!.status = "CONFIRMED";
    const conv = await ctx.store.getOrCreateConversation(CLINIC_ID, OTHER_PATIENT);
    await ctx.store.updateConversation(conv.id, { marketingOptOutAt: at("2026-10-10T12:00:00Z") });
    expect(await ctx.recall.run(TUESDAY)).toEqual({ sent: 0 });
  });

  it("releases the invitation when the send fails and caps each run", async () => {
    const { ctx, maria, joao, visit, consent } = await setup();
    visit(joao.id, "proc_avaliacao", "2026-01-05T13:00:00Z");
    ctx.agendaRepo.appointments.splice(1, 1); // João only has the January visit
    await consent(maria.id);
    await consent(joao.id);
    const recall = new RecallService({
      repo: ctx.recallRepo,
      channel: ctx.channel,
      store: ctx.store,
      logger: silentLogger,
      config: { maxPerRun: 1 },
    });
    const send = ctx.channel.send.bind(ctx.channel);
    ctx.channel.send = async () => {
      throw new Error("Meta unavailable");
    };
    expect(await recall.run(TUESDAY)).toEqual({ sent: 0 });
    expect(ctx.recallRepo.invited.size).toBe(0);

    ctx.channel.send = send;
    expect(await recall.run(TUESDAY)).toEqual({ sent: 1 });
    expect(await recall.run(at("2026-10-20T14:00:00Z"))).toEqual({ sent: 1 });
    expect(ctx.channel.outbox.map((m) => m.to).sort()).toEqual([PATIENT, OTHER_PATIENT].sort());
  });
});

describe("RecallService panel side", () => {
  it("lists overdue patients with masked phones and their status", async () => {
    const { ctx, maria, consent } = await setup();
    await consent(maria.id);
    const list = await ctx.recall.list(CLINIC_ID, TUESDAY);
    expect(list).toMatchObject({ afterMonths: 6, schedule: "terça, das 9h às 12h" });
    expect(list.consentText).toContain("PARAR");
    expect(list.rows).toEqual([
      {
        patientId: maria.id,
        patientName: "Maria Exemplo",
        patientPhone: "***0001",
        lastVisitAt: "2026-03-10T13:00:00.000Z",
        lastProcedure: "Limpeza (profilaxia)",
        status: "due",
        invitedAt: null,
        optedOutAt: null,
      },
    ]);
    expect((await ctx.recall.list("outra_clinica", TUESDAY)).rows).toEqual([]);
  });

  it("records consent only for the clinic's patients", async () => {
    const { ctx, maria } = await setup();
    await ctx.recall.setConsent(CLINIC_ID, maria.id, { granted: true }, TUESDAY);
    expect(ctx.recallRepo.consents).toEqual([{ patientId: maria.id, granted: true, at: TUESDAY }]);
    const fail = (clinic: string, id: string, body: unknown) =>
      ctx.recall.setConsent(clinic, id, body, TUESDAY).catch((e: unknown) => e as RecallError);
    expect(await fail("outra_clinica", maria.id, { granted: true })).toMatchObject({ status: 404 });
    expect(await fail(CLINIC_ID, "pat_x", { granted: true })).toMatchObject({ status: 404 });
    expect(await fail(CLINIC_ID, maria.id, { granted: "sim" })).toMatchObject({ status: 422 });
  });
});

describe("invitation buttons", () => {
  it("maps the reply ids", () => {
    expect(detectIntent(undefined, "recall:schedule")).toEqual({ kind: "recall_schedule" });
    expect(detectIntent(undefined, "recall:stop")).toEqual({ kind: "opt_out" });
  });

  it("opts out even while the front desk has the chat", async () => {
    const { ctx } = await setup();
    await deliver(echoPayload("Oi Maria, aqui é a Ana."), ctx.deps);
    await deliver(buttonPayload("recall:stop", "Não quero receber"), ctx.deps);
    const conv = await ctx.store.getOrCreateConversation(CLINIC_ID, PATIENT);
    expect(conv.marketingOptOutAt).not.toBeNull();
    expect(ctx.channel.outbox.at(-1)).toMatchObject({ kind: "text" });
  });

  it("leaves 'Quero agendar' to the front desk while it has the chat", async () => {
    const { ctx } = await setup();
    await deliver(echoPayload("Oi Maria, aqui é a Ana."), ctx.deps);
    await deliver(buttonPayload("recall:schedule", "Quero agendar"), ctx.deps);
    expect(ctx.channel.outbox).toHaveLength(0);
  });
});

describe("InMemoryRecallRepository", () => {
  it("ignores other clinics", async () => {
    const { ctx } = await setup();
    const repo = new InMemoryRecallRepository(ctx.agendaRepo, ctx.store, "Clínica Sorriso");
    expect(await repo.rows("outra_clinica", TUESDAY, TUESDAY)).toEqual([]);
    expect(await repo.clinic("outra_clinica")).toBeNull();
  });
});
