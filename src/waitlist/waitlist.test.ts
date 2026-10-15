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
import { normalizeWebhook } from "../whatsapp/index.js";
import { WaitlistError, waitlistButtons } from "./waitlist.js";

const at = (iso: string) => new Date(iso);
const THIRD = "5511900000003";
/** Tuesday 20/10, 10:00 in São Paulo: the only gap left in the week. */
const GAP = at("2026-10-20T13:00:00Z");

/**
 * The week is full (blocks) except Tuesday 10:00, which João holds. Maria waits for an
 * evaluation until Thursday 22/10. The clock is Monday 19/10, 09:00.
 */
async function setup() {
  const ctx = makeDeps();
  ctx.agendaRepo.addBlock({
    dentistId: "dentist_dev",
    startsAt: at("2026-10-19T03:00:00Z"),
    endsAt: GAP,
  });
  ctx.agendaRepo.addBlock({
    dentistId: "dentist_dev",
    startsAt: at("2026-10-20T13:30:00Z"),
    endsAt: at("2026-10-23T03:00:00Z"),
  });
  const maria = await ctx.agenda.cadastrarPaciente({ name: "Maria Exemplo", phone: PATIENT });
  const joao = await ctx.agenda.cadastrarPaciente({ name: "João Exemplo", phone: OTHER_PATIENT });
  const slot = {
    dentistId: "dentist_dev",
    procedureId: "proc_avaliacao",
    startsAt: GAP,
    endsAt: at("2026-10-20T13:30:00Z"),
  };
  const { appointmentId: joaoAppt } = await ctx.agenda.reservar({ patientId: joao.id, slot });
  const wait = (patientId: string, until = "2026-10-22") =>
    ctx.waitlist.add(CLINIC_ID, { patientId, procedureId: "proc_avaliacao", until }, ctx.clock.now);
  const tap = async (offerId: string, accept: boolean, from = PATIENT) => {
    const before = ctx.channel.outbox.length;
    const [id] = waitlistButtons(offerId).slice(accept ? 0 : 1);
    for (const e of normalizeWebhook(buttonPayload(id!, accept ? "Quero" : "Não", from)))
      await handleWhatsAppEvent(e, ctx.deps);
    return ctx.channel.outbox
      .slice(before)
      .map((m) => ("body" in m ? m.body : ""))
      .filter((b) => !b.startsWith("Olá! Sou o assistente"));
  };
  return { ...ctx, maria, joao, slot, joaoAppt, wait, tap };
}

describe("waiting list", () => {
  it("validates what the front desk adds", async () => {
    const { waitlist, maria, clock, wait } = await setup();
    const bad = (body: unknown) => waitlist.add(CLINIC_ID, body, clock.now);
    await expect(bad({ patientId: maria.id })).rejects.toMatchObject({ status: 422 });
    await expect(wait(maria.id, "2026-10-18")).rejects.toMatchObject({ status: 422 });
    await expect(wait(maria.id, "2027-01-30")).rejects.toMatchObject({ status: 422 });
    await expect(wait("pat_unknown")).rejects.toBeInstanceOf(WaitlistError);
    await expect(
      waitlist.add(
        CLINIC_ID,
        { patientId: maria.id, procedureId: "proc_x", until: "2026-10-22" },
        clock.now,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await wait(maria.id);
    await expect(wait(maria.id)).rejects.toMatchObject({ status: 409 });
    await expect(waitlist.add("other_clinic", {}, clock.now)).rejects.toMatchObject({
      status: 422,
    });
  });

  it("offers a freed slot and books it when the patient accepts", async () => {
    const { waitlist, waitlistRepo, agendaRepo, channel, clock, maria, joaoAppt, wait, tap } =
      await setup();
    await wait(maria.id);
    expect(await waitlist.run(clock.now)).toEqual({ sent: 0 });

    await agendaRepo.cancelAppointment(joaoAppt);
    expect(await waitlist.run(clock.now)).toEqual({ sent: 1 });
    expect(channel.outbox.at(-1)).toMatchObject({
      to: PATIENT,
      template: "vaga_disponivel",
      params: ["Maria", "Avaliação", "Clínica Sorriso", "terça-feira, 20/10 às 10:00"],
    });
    // Not offered again while the patient has it.
    expect(await waitlist.run(clock.now)).toEqual({ sent: 0 });

    const offer = waitlistRepo.offers[0]!;
    expect(await tap(offer.id, true)).toEqual([
      expect.stringContaining("Pronto! Sua consulta de Avaliação ficou para terça-feira, 20/10"),
    ]);
    const mine = agendaRepo.appointments.find((a) => a.patientId === maria.id);
    expect(mine).toMatchObject({ startsAt: GAP, status: "PENDING_CONFIRMATION" });
    expect(waitlistRepo.entries[0]).toMatchObject({ status: "BOOKED", appointmentId: mine!.id });
    expect(offer.answer).toBe("ACCEPTED");
    expect(await tap(offer.id, true)).toEqual([expect.stringContaining("já respondeu")]);
  });

  it("gives the slot to the first who accepts; the others stay in line", async () => {
    const {
      waitlist,
      waitlistRepo,
      agenda,
      agendaRepo,
      channel,
      clock,
      maria,
      joaoAppt,
      wait,
      tap,
    } = await setup();
    const ana = await agenda.cadastrarPaciente({ name: "Ana Exemplo", phone: THIRD });
    await wait(maria.id);
    await wait(ana.id);
    await agendaRepo.cancelAppointment(joaoAppt);
    expect(await waitlist.run(clock.now)).toEqual({ sent: 2 });
    expect(channel.outbox.slice(-2).map((m) => m.to)).toEqual([PATIENT, THIRD]);

    const [toMaria, toAna] = waitlistRepo.offers;
    expect(await tap(toAna!.id, true, THIRD)).toEqual([expect.stringContaining("Pronto!")]);
    expect(await tap(toMaria!.id, true)).toEqual([
      expect.stringContaining("acabou de ser preenchida"),
    ]);
    expect(toMaria!.answer).toBe("TAKEN");
    expect(waitlistRepo.entries.map((e) => e.status)).toEqual(["WAITING", "BOOKED"]);
    // Maria's tap on Ana's offer is not hers.
    expect(await tap(toAna!.id, true)).toEqual([expect.stringContaining("Não encontrei")]);
  });

  it("keeps the patient in line after a no, without offering the same slot again", async () => {
    const { waitlist, waitlistRepo, agendaRepo, clock, maria, joaoAppt, wait, tap } = await setup();
    await wait(maria.id);
    await agendaRepo.cancelAppointment(joaoAppt);
    await waitlist.run(clock.now);
    expect(await tap(waitlistRepo.offers[0]!.id, false)).toEqual([
      expect.stringContaining("continua na lista"),
    ]);
    clock.now = new Date(clock.now.getTime() + 2 * 3600_000);
    expect(await waitlist.run(clock.now)).toEqual({ sent: 0 });
    expect(waitlistRepo.entries[0]!.status).toBe("WAITING");
  });

  it("moves the patient's later appointment instead of booking a second one", async () => {
    const { waitlist, waitlistRepo, agenda, agendaRepo, clock, maria, joaoAppt, wait, tap } =
      await setup();
    const { appointmentId } = await agenda.reservar({
      patientId: maria.id,
      slot: {
        dentistId: "dentist_dev",
        procedureId: "proc_avaliacao",
        startsAt: at("2026-10-26T13:00:00Z"),
        endsAt: at("2026-10-26T13:30:00Z"),
      },
    });
    await wait(maria.id);
    await agendaRepo.cancelAppointment(joaoAppt);
    await waitlist.run(clock.now);
    expect(await tap(waitlistRepo.offers[0]!.id, true)).toEqual([
      expect.stringContaining("foi antecipada para terça-feira, 20/10"),
    ]);
    const mine = agendaRepo.appointments.filter(
      (a) => a.patientId === maria.id && a.status !== "CANCELLED",
    );
    expect(mine).toEqual([expect.objectContaining({ id: appointmentId, startsAt: GAP })]);
  });

  it("does not offer a slot later than the patient's own booking", async () => {
    const { waitlist, agendaRepo, clock, maria, joaoAppt, wait } = await setup();
    // Booked Monday 12:00, before the gap (written straight in: the block covers it now).
    agendaRepo.appointments.push({
      id: "appt_maria",
      patientId: maria.id,
      dentistId: "dentist_dev",
      procedureId: "proc_avaliacao",
      startsAt: at("2026-10-19T15:00:00Z"),
      endsAt: at("2026-10-19T15:30:00Z"),
      status: "CONFIRMED",
      reminderSentAt: null,
    });
    await wait(maria.id);
    await agendaRepo.cancelAppointment(joaoAppt);
    expect(await waitlist.run(clock.now)).toEqual({ sent: 0 });
  });

  it("sends nothing at night and expires entries past their date", async () => {
    const { waitlist, waitlistRepo, agendaRepo, clock, maria, joaoAppt, wait } = await setup();
    await wait(maria.id, "2026-10-20");
    await agendaRepo.cancelAppointment(joaoAppt);
    expect(await waitlist.run(at("2026-10-19T02:00:00Z"))).toEqual({ sent: 0 });
    clock.now = at("2026-10-21T12:00:00Z");
    expect(await waitlist.run(clock.now)).toEqual({ sent: 0 });
    expect(waitlistRepo.entries[0]).toMatchObject({ status: "EXPIRED" });
  });

  it("removes a patient and gives a failed send back", async () => {
    const { waitlist, waitlistRepo, agendaRepo, channel, clock, maria, joaoAppt, wait } =
      await setup();
    const { id } = await wait(maria.id);
    await agendaRepo.cancelAppointment(joaoAppt);
    const send = channel.send.bind(channel);
    channel.send = async () => {
      throw new Error("network");
    };
    expect(await waitlist.run(clock.now)).toEqual({ sent: 0 });
    expect(waitlistRepo.offers).toEqual([]);
    channel.send = send;

    await waitlist.remove(CLINIC_ID, id, clock.now);
    await expect(waitlist.remove(CLINIC_ID, id, clock.now)).rejects.toMatchObject({ status: 404 });
    expect(await waitlist.run(clock.now)).toEqual({ sent: 0 });
    const list = await waitlist.list(CLINIC_ID, clock.now);
    expect(list.rows).toEqual([
      expect.objectContaining({
        patientName: "Maria Exemplo",
        patientPhone: "***0001",
        status: "REMOVED",
        until: "2026-10-23T03:00:00.000Z",
      }),
    ]);
  });
});

describe("waitlist buttons", () => {
  it("are read before anything else", () => {
    expect(detectIntent("Quero esse horário", "wait:offer_1:yes")).toEqual({
      kind: "waitlist_answer",
      offerId: "offer_1",
      accept: true,
    });
    expect(detectIntent("Não, obrigado", "wait:offer_1:no")).toMatchObject({ accept: false });
  });
});
