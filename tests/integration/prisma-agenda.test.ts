import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaConversationStore } from "../../src/conversation/prisma-store.js";
import { FieldCipher } from "../../src/privacy/index.js";
import { SlotUnavailableError } from "../../src/scheduling/agenda-provider.js";
import type { AgendaService } from "../../src/scheduling/agenda-service.js";
import { PrismaAppointmentReminderRepository } from "../../src/scheduling/appointment-reminders.js";
import { PrismaAgendaRepository, prismaAgendaFor } from "../../src/scheduling/prisma-agenda.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
// Monday 2026-10-19, 09:00 in São Paulo.
const now = new Date("2026-10-19T12:00:00Z");

describe.skipIf(!url)("PrismaAgendaRepository (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "z".repeat(32));
  let db: PrismaClient;
  let agenda: AgendaService;
  let clinicId = "";
  let otherClinicId = "";
  let procedureId = "";

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    const clinic = await db.clinic.create({ data: { name: "Clínica Agenda Teste" } });
    clinicId = clinic.id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Clínica" } })).id;
    const dentist = await db.dentist.create({ data: { clinicId, name: "Dra. Teste" } });
    await db.workingHours.create({
      data: { dentistId: dentist.id, weekday: 2, startMinute: 8 * 60, endMinute: 12 * 60 },
    });
    procedureId = (
      await db.procedure.create({ data: { clinicId, name: "Avaliação", durationMinutes: 30 } })
    ).id;
    agenda = (await prismaAgendaFor(db, cipher, clinicId, { now: () => now }))!;
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.conversation.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.workingHours.deleteMany({ where: { dentist: { clinicId: id } } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("stores the patient phone encrypted and finds it by hash", async () => {
    const p = await agenda.cadastrarPaciente({ name: "Paciente Exemplo", phone: "5511900000001" });
    const row = await db.patient.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.phoneEncrypted).not.toContain("5511900000001");
    expect(await agenda.buscarPaciente({ phone: "5511900000001" })).toEqual(p);
  });

  it("registers a patient once when the same number arrives twice at the same time", async () => {
    const ps = await Promise.all(
      Array.from({ length: 6 }, () =>
        agenda.cadastrarPaciente({ name: "Paciente Exemplo", phone: "5511900000008" }),
      ),
    );
    expect(new Set(ps.map((p) => p.id)).size).toBe(1);
  });

  it("never double-books under concurrent requests", async () => {
    const p = (await agenda.buscarPaciente({ phone: "5511900000001" }))!;
    const [slot] = await agenda.listarHorarios({ procedureId, from: "2026-10-20", days: 1 });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => agenda.reservar({ patientId: p.id, slot: slot! })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected"))
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SlotUnavailableError);
    expect(await db.appointment.count({ where: { clinicId, startsAt: slot!.startsAt } })).toBe(1);
  });

  it("keeps agenda and patients scoped to the clinic", async () => {
    const p = (await agenda.buscarPaciente({ phone: "5511900000001" }))!;
    const repo = new PrismaAgendaRepository(db, cipher, clinicId, "America/Sao_Paulo");
    expect(await repo.patientById(p.id)).toEqual({ ...p, phone: "5511900000001" });
    const otherRepo = new PrismaAgendaRepository(db, cipher, otherClinicId, "America/Sao_Paulo");
    expect(await otherRepo.patientById(p.id)).toBeNull();
    const other = (await prismaAgendaFor(db, cipher, otherClinicId))!;
    expect(await other.buscarPaciente({ phone: "5511900000001" })).toBeNull();
    expect(await other.listarProcedimentos()).toEqual([]);
  });

  it("persists the orchestrator state and patient link on the conversation", async () => {
    const store = new PrismaConversationStore(db, cipher);
    const conv = await store.getOrCreateConversation(clinicId, "5511900000001");
    const p = (await agenda.buscarPaciente({ phone: "5511900000001" }))!;
    await store.updateConversation(conv.id, { patientId: p.id, agentState: { offers: [] } });
    const again = await store.getOrCreateConversation(clinicId, "5511900000001");
    expect(again.patientId).toBe(p.id);
    expect(again.agentState).toEqual({ offers: [] });
    await store.updateConversation(conv.id, { agentState: null });
    expect((await store.getOrCreateConversation(clinicId, "5511900000001")).agentState).toBeNull();
  });

  it("finds tomorrow's appointments to remind, claims each once and confirms", async () => {
    const p = (await agenda.buscarPaciente({ phone: "5511900000001" }))!;
    const slots = await agenda.listarHorarios({ procedureId, from: "2026-10-20", days: 1 });
    const slot = slots.at(-1)!;
    const { appointmentId } = await agenda.reservar({ patientId: p.id, slot });
    const repo = new PrismaAppointmentReminderRepository(db, cipher);

    // Scoped to this clinic: other test files write appointments with another key in parallel.
    const found = await repo.candidates(now, new Date(now.getTime() + 2 * 86_400_000), clinicId);
    expect(found.find((c) => c.appointmentId === appointmentId)).toEqual({
      appointmentId,
      clinicId,
      clinicName: "Clínica Agenda Teste",
      clinicTimeZone: "America/Sao_Paulo",
      patientName: "Paciente Exemplo",
      phone: "5511900000001",
      startsAt: slot.startsAt,
    });
    expect(await repo.claim(appointmentId, now)).toBe(true);
    expect(await repo.claim(appointmentId, now)).toBe(false);
    await repo.release(appointmentId);
    expect(await repo.claim(appointmentId, now)).toBe(true);

    await agenda.confirmar({ appointmentId, patientId: p.id });
    const row = await db.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    expect(row.status).toBe("CONFIRMED");
    expect(row.reminderSentAt).not.toBeNull();

    // Moving it needs a new reminder and a new confirmation.
    const earlier = slots.find((s) => s.endsAt <= slot.startsAt)!;
    await agenda.remarcar({ appointmentId, patientId: p.id, slot: earlier });
    const moved = await db.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    expect(moved).toMatchObject({ status: "PENDING_CONFIRMATION", reminderSentAt: null });
  });
});
