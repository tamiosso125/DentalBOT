import { describe, expect, it } from "vitest";
import {
  buttonPayload,
  CLINIC_ID,
  makeDeps,
  OTHER_PATIENT,
  PATIENT,
} from "../../tests/support/fixtures.js";
import { handleWhatsAppEvent } from "../conversation/handler.js";
import { detectIntent } from "../conversation/intents.js";
import { normalizeWebhook, renderTemplate } from "../whatsapp/index.js";
import { AUTHORIZATION_MESSAGES, deniedButtons, normalizeCard } from "./authorizations.js";

const at = (iso: string) => new Date(iso);
const PLAN = "plan_odontoprev";

/** Maria (Odontoprev, card 123 456 789) books an extração on Wednesday 21/10 at 10:00. */
async function setup() {
  const ctx = makeDeps();
  const maria = await ctx.agenda.cadastrarPaciente({ name: "Maria Exemplo", phone: PATIENT });
  const joao = await ctx.agenda.cadastrarPaciente({ name: "João Exemplo", phone: OTHER_PATIENT });
  const book = async (patientId: string, procedureId: string, iso: string) => {
    const day = iso.slice(0, 10);
    const slots = await ctx.agenda.listarHorarios({ procedureId, from: day, days: 1 });
    const slot = slots.find((s) => s.startsAt.toISOString() === iso)!;
    return (await ctx.agenda.reservar({ patientId, slot })).appointmentId;
  };
  expect(await ctx.insurance.register(CLINIC_ID, maria.id, "odontoprev", "123 456 789")).toEqual({
    plan: "Odontoprev",
  });
  const extracao = await book(maria.id, "proc_extracao", "2026-10-21T13:00:00.000Z");
  const tap = async (replyId: string, title: string, from = PATIENT) => {
    const before = ctx.channel.outbox.length;
    for (const e of normalizeWebhook(buttonPayload(replyId, title, from)))
      await handleWhatsAppEvent(e, ctx.deps);
    return ctx.channel.outbox.slice(before).map((m) => ("body" in m ? m.body : m.kind));
  };
  return { ...ctx, maria, joao, book, extracao, tap };
}

describe("insurance authorizations", () => {
  it("registers plan and card from the bot, checking plan and card", async () => {
    const { insurance, insuranceRepo, maria } = await setup();
    expect(insuranceRepo.patientPlans.get(maria.id)).toEqual({ planId: PLAN, card: "123456789" });
    expect(await insurance.register(CLINIC_ID, maria.id, "Amil", "123456")).toEqual({
      error: "plan",
      plans: ["Odontoprev"],
    });
    expect(await insurance.register(CLINIC_ID, maria.id, "Odontoprev", "12")).toEqual({
      error: "card",
    });
    expect(await insurance.register("other", maria.id, "Odontoprev", "123456")).toMatchObject({
      error: "plan",
    });
    expect(await insurance.requiresAuthorization(CLINIC_ID, maria.id, "proc_extracao")).toBe(true);
    expect(await insurance.requiresAuthorization(CLINIC_ID, maria.id, "proc_limpeza")).toBe(false);
    expect(normalizeCard(" 0012.3456-7 ")).toBe("001234567");
    expect(normalizeCard("12<script>")).toBeNull();
  });

  it("lists upcoming appointments that need authorization, with the card", async () => {
    const { insurance, maria, joao, book, extracao } = await setup();
    await book(maria.id, "proc_limpeza", "2026-10-22T11:00:00.000Z");
    await book(joao.id, "proc_extracao", "2026-10-23T11:00:00.000Z");
    const list = await insurance.list(CLINIC_ID, at("2026-10-19T12:00:00Z"));
    expect(list.plans).toEqual([{ id: PLAN, name: "Odontoprev" }]);
    expect(list.pending).toEqual([
      expect.objectContaining({
        appointmentId: extracao,
        patientName: "Maria Exemplo",
        patientPhone: "***0001",
        planName: "Odontoprev",
        card: "123456789",
        procedureName: "Extração simples",
        status: "PENDING",
      }),
    ]);
    expect(list.decided).toEqual([]);
    expect((await insurance.list("other", at("2026-10-19T12:00:00Z"))).pending).toEqual([]);
  });

  it("tells the patient it was authorized, once", async () => {
    const { insurance, extracao, channel } = await setup();
    const now = at("2026-10-19T15:00:00Z");
    expect(await insurance.decide(CLINIC_ID, extracao, { authorized: true }, now)).toEqual({
      notified: true,
    });
    expect(channel.outbox.at(-1)).toEqual(
      expect.objectContaining({
        to: PATIENT,
        template: "convenio_autorizado",
        params: ["Maria", "Odontoprev", "quarta-feira, 21/10 às 10:00", "Clínica Sorriso"],
      }),
    );
    expect(
      renderTemplate("convenio_autorizado", ["Maria", "Odontoprev", "x", "Clínica Sorriso"]),
    ).toContain("autorizou");
    await expect(
      insurance.decide(CLINIC_ID, extracao, { authorized: false }, now),
    ).rejects.toMatchObject({ status: 409 });
    const list = await insurance.list(CLINIC_ID, now);
    expect(list.pending).toEqual([]);
    expect(list.decided).toEqual([
      expect.objectContaining({ status: "AUTHORIZED", notifiedAt: now.toISOString() }),
    ]);
  });

  it("rejects bad input and appointments that need no authorization", async () => {
    const { insurance, maria, book, extracao, agenda } = await setup();
    const now = at("2026-10-19T15:00:00Z");
    const limpeza = await book(maria.id, "proc_limpeza", "2026-10-22T11:00:00.000Z");
    await expect(
      insurance.decide(CLINIC_ID, limpeza, { authorized: true }, now),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      insurance.decide(CLINIC_ID, extracao, { authorized: "sim" }, now),
    ).rejects.toMatchObject({
      status: 422,
    });
    await agenda.cancelar({ appointmentId: extracao, patientId: maria.id });
    await expect(
      insurance.decide(CLINIC_ID, extracao, { authorized: true }, now),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect((await insurance.list(CLINIC_ID, now)).pending).toEqual([]);
  });

  it("on a denial the patient can keep the appointment as private", async () => {
    const { insurance, insuranceRepo, extracao, channel, tap } = await setup();
    await insurance.decide(CLINIC_ID, extracao, { authorized: false }, at("2026-10-19T15:00:00Z"));
    const id = insuranceRepo.decisions[0]!.id;
    expect(channel.outbox.at(-1)).toEqual(
      expect.objectContaining({ template: "convenio_negado", buttonPayloads: deniedButtons(id) }),
    );
    expect(detectIntent(undefined, `auth:${id}:private`)).toEqual({
      kind: "insurance_private",
      authorizationId: id,
    });
    expect(await tap(`auth:${id}:private`, "Seguir como particular", OTHER_PATIENT)).toContain(
      AUTHORIZATION_MESSAGES.notFound,
    );
    expect((await tap(`auth:${id}:private`, "Seguir como particular")).at(-1)).toBe(
      AUTHORIZATION_MESSAGES.privateChosen(
        "quarta-feira, 21/10 às 10:00",
        "Extração simples",
        30000,
      ),
    );
    expect((await tap(`auth:${id}:private`, "Seguir como particular")).at(-1)).toBe(
      AUTHORIZATION_MESSAGES.alreadyChosen,
    );
    expect((await insurance.list(CLINIC_ID, at("2026-10-19T16:00:00Z"))).decided[0]).toMatchObject({
      status: "DENIED",
      privateChosenAt: expect.any(String),
    });
  });

  it("keeps the decision when the notice fails", async () => {
    const { insurance, extracao, channel } = await setup();
    channel.send = async () => {
      throw new Error("network");
    };
    const now = at("2026-10-19T15:00:00Z");
    expect(await insurance.decide(CLINIC_ID, extracao, { authorized: true }, now)).toEqual({
      notified: false,
    });
    expect((await insurance.list(CLINIC_ID, now)).decided).toEqual([
      expect.objectContaining({ status: "AUTHORIZED", notifiedAt: null }),
    ]);
  });

  it("lets the front desk set or clear the patient's plan", async () => {
    const { insurance, joao } = await setup();
    expect(await insurance.patientInsurance(CLINIC_ID, joao.id)).toEqual({
      planId: null,
      card: null,
      plans: [{ id: PLAN, name: "Odontoprev" }],
    });
    await insurance.setPatientInsurance(CLINIC_ID, joao.id, { planId: PLAN, card: "98765-4321" });
    expect(await insurance.patientInsurance(CLINIC_ID, joao.id)).toMatchObject({
      planId: PLAN,
      card: "987654321",
    });
    await insurance.setPatientInsurance(CLINIC_ID, joao.id, { planId: PLAN });
    expect(await insurance.patientInsurance(CLINIC_ID, joao.id)).toMatchObject({ card: null });
    await insurance.setPatientInsurance(CLINIC_ID, joao.id, { planId: null });
    expect(await insurance.patientInsurance(CLINIC_ID, joao.id)).toMatchObject({ planId: null });
    for (const [body, status] of [
      [{ planId: "plan_x" }, 422],
      [{ planId: PLAN, card: "1" }, 422],
      [{ plan: PLAN }, 422],
    ] as const)
      await expect(insurance.setPatientInsurance(CLINIC_ID, joao.id, body)).rejects.toMatchObject({
        status,
      });
    await expect(
      insurance.setPatientInsurance(CLINIC_ID, "p9", { planId: null }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(insurance.patientInsurance(CLINIC_ID, "p9")).rejects.toMatchObject({
      status: 404,
    });
  });
});
