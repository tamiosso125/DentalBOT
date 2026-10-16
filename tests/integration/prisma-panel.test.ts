import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPanelQueries } from "../../src/panel/panel-queries.js";
import { PrismaAgendaRepository } from "../../src/scheduling/prisma-agenda.js";
import { FieldCipher } from "../../src/privacy/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const PHONE = "5511900000021";

describe.skipIf(!url)("PrismaPanelQueries (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "z".repeat(32));
  let db: PrismaClient;
  let panel: PrismaPanelQueries;
  let clinicId = "";
  let otherClinicId = "";
  let patientId = "";

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    panel = new PrismaPanelQueries(db, cipher);
    clinicId = (await db.clinic.create({ data: { name: "Clínica Painel Teste" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Clínica" } })).id;
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Painel" } })).id;
    await db.dentist.create({ data: { clinicId, name: "Dr. Inativo", active: false } });
    const procedureId = (
      await db.procedure.create({ data: { clinicId, name: "Limpeza", durationMinutes: 45 } })
    ).id;
    patientId = (
      await db.patient.create({
        data: {
          clinicId,
          name: "Maria Exemplo",
          phoneHash: cipher.hash(PHONE),
          phoneEncrypted: cipher.encrypt(PHONE),
        },
      })
    ).id;
    await db.patient.create({
      data: {
        clinicId,
        name: "José da Conceição",
        phoneHash: cipher.hash("5511900000022"),
        phoneEncrypted: cipher.encrypt("5511900000022"),
        birthDate: new Date("1985-03-15T00:00:00Z"),
      },
    });
    await db.patient.create({
      data: {
        clinicId,
        name: "Paciente anonimizado",
        phoneHash: "anon-hash-painel",
        phoneEncrypted: "x",
        birthDate: new Date("1985-03-15T00:00:00Z"),
        anonymizedAt: new Date("2026-10-01T00:00:00Z"),
      },
    });
    const at = (iso: string, minutes: number) => ({
      startsAt: new Date(iso),
      endsAt: new Date(new Date(iso).getTime() + minutes * 60_000),
    });
    // Monday 19/10 08:00 and 23:30 in São Paulo (the second is already Tuesday in UTC),
    // then Tuesday 20/10 08:00.
    for (const iso of ["2026-10-19T11:00:00Z", "2026-10-20T02:30:00Z", "2026-10-20T11:00:00Z"]) {
      await db.appointment.create({
        data: { clinicId, patientId, dentistId, procedureId, ...at(iso, 45) },
      });
    }
    await db.quote.create({
      data: { clinicId, patientId, dentistId, totalCents: 250_00, status: "SENT" },
    });
    await db.conversation.create({
      data: {
        clinicId,
        patientId,
        contactHash: cipher.hash(PHONE),
        contactEncrypted: cipher.encrypt(PHONE),
        botPausedUntil: new Date("2026-10-19T16:00:00Z"),
        lastInboundAt: new Date("2026-10-19T12:00:00Z"),
      },
    });
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.conversation.deleteMany({ where: { clinicId: id } });
      await db.quote.deleteMany({ where: { clinicId: id } });
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("lists the agenda by clinic-local days, with the phone masked", async () => {
    const monday = await panel.agenda(clinicId, { from: "2026-10-19", days: 1 });
    expect(monday.map((a) => a.startsAt)).toEqual([
      "2026-10-19T11:00:00.000Z",
      "2026-10-20T02:30:00.000Z",
    ]);
    expect(monday[0]).toMatchObject({
      patientName: "Maria Exemplo",
      patientPhone: "***0021",
      procedureName: "Limpeza",
      dentistName: "Dra. Painel",
    });
    expect(await panel.agenda(clinicId, { from: "2026-10-19", days: 2 })).toHaveLength(3);
    expect(await panel.agenda(otherClinicId, { from: "2026-10-19", days: 7 })).toEqual([]);
  });

  it("shows one appointment with ids for editing, only in its clinic", async () => {
    const [first] = await panel.agenda(clinicId, { from: "2026-10-19", days: 1 });
    const detail = (await panel.appointment(clinicId, first!.id))!;
    expect(detail).toMatchObject({ ...first, patientPhone: "***0021" });
    expect(detail.procedureId).toMatch(/.+/);
    expect(detail.dentistId).toMatch(/.+/);
    expect(await panel.appointment(otherClinicId, first!.id)).toBeNull();
  });

  it("finds patients by name or exact phone, only in the clinic", async () => {
    expect(await panel.patients(clinicId, "maria")).toEqual([
      { id: patientId, name: "Maria Exemplo", phone: "***0021" },
    ]);
    expect(await panel.patients(clinicId, "(11) 90000-0021")).toHaveLength(1);
    expect(await panel.patients(clinicId, "0021")).toEqual([]);
    expect(await panel.patients(otherClinicId, "maria")).toEqual([]);
  });

  it("finds a name without accents, in any word order, and by birth date", async () => {
    const jose = { name: "José da Conceição", phone: "***0022" };
    expect(await panel.patients(clinicId, "jose")).toMatchObject([jose]);
    expect(await panel.patients(clinicId, "CONCEICAO jose")).toMatchObject([jose]);
    expect(await panel.patients(clinicId, "conceição")).toMatchObject([jose]);
    expect(await panel.patients(clinicId, "xyz")).toEqual([]);
    expect(await panel.patients(clinicId, "15/03/1985")).toMatchObject([jose]);
    expect(await panel.patients(clinicId, "1985-03-15")).toMatchObject([jose]);
    expect(await panel.patients(clinicId, "16/03/1985")).toEqual([]);
    expect(await panel.patients(clinicId, "31/02/1985")).toEqual([]);
    expect(await panel.patients(otherClinicId, "15/03/1985")).toEqual([]);
    expect(await panel.patients(clinicId, "anonimizado")).toEqual([]);
  });

  it("returns the catalog with active dentists only", async () => {
    const c = (await panel.catalog(clinicId))!;
    expect(c.dentists.map((d) => d.name)).toEqual(["Dra. Painel"]);
    expect(c.procedures.map((p) => p.name)).toEqual(["Limpeza"]);
    expect(await panel.catalog("nope")).toBeNull();
  });

  it("lists quotes and paused conversations of the clinic", async () => {
    expect(await panel.quotes(clinicId)).toMatchObject([
      { status: "SENT", patientName: "Maria Exemplo" },
    ]);
    expect(await panel.quotes(clinicId, "ACCEPTED")).toEqual([]);
    expect(await panel.handoffs(clinicId, new Date("2026-10-19T13:00:00Z"))).toMatchObject([
      { contact: "***0021", patientName: "Maria Exemplo" },
    ]);
    expect(await panel.handoffs(clinicId, new Date("2026-10-19T17:00:00Z"))).toEqual([]);
  });

  it("lists unmarked past appointments and counts this month's attendance", async () => {
    const now = new Date("2026-10-20T12:00:00Z"); // Tuesday 09:00 in São Paulo
    const [first, second, third] = await panel.agenda(clinicId, { from: "2026-10-19", days: 2 });
    // Unmarked for more than 30 days: no longer pending.
    const old = await db.appointment.create({
      data: {
        clinicId,
        patientId,
        dentistId: (await db.dentist.findFirstOrThrow({ where: { clinicId, active: true } })).id,
        procedureId: (await db.procedure.findFirstOrThrow({ where: { clinicId } })).id,
        startsAt: new Date("2026-09-10T12:00:00Z"),
        endsAt: new Date("2026-09-10T12:45:00Z"),
      },
    });
    const before = await panel.attendance(clinicId, now);
    expect(before.pending.map((a) => a.id)).toEqual([first!.id, second!.id, third!.id]);
    expect(before.pending[0]!.patientPhone).toBe("***0021");
    expect(before.month).toEqual({ attended: 0, noShow: 0, noShowNotices: 0, rebooked: 0 });

    const repo = new PrismaAgendaRepository(db, cipher, clinicId, "America/Sao_Paulo");
    await repo.setAttendance(first!.id, true);
    await repo.setAttendance(second!.id, false);
    await new PrismaAgendaRepository(db, cipher, otherClinicId, "America/Sao_Paulo").setAttendance(
      third!.id,
      true,
    );
    const after = await panel.attendance(clinicId, now);
    expect(after.pending.map((a) => a.id)).toEqual([third!.id]);
    expect(after.month).toEqual({ attended: 1, noShow: 1, noShowNotices: 0, rebooked: 0 });
    expect(await panel.attendance(otherClinicId, now)).toEqual({
      pending: [],
      month: { attended: 0, noShow: 0, noShowNotices: 0, rebooked: 0 },
    });

    // The bot sent "we missed you" for the no-show, and Maria booked again afterwards.
    await db.appointment.update({
      where: { id: second!.id },
      // createdAt after the notice: the missed appointment itself never counts as rebooked.
      data: {
        noShowNoticeAt: new Date("2026-10-20T11:00:00Z"),
        createdAt: new Date("2026-10-20T11:15:00Z"),
      },
    });
    expect((await panel.attendance(clinicId, now)).month).toMatchObject({
      noShowNotices: 1,
      rebooked: 0,
    });
    const again = await db.appointment.create({
      data: {
        clinicId,
        patientId,
        dentistId: old.dentistId,
        procedureId: old.procedureId,
        startsAt: new Date("2026-10-27T12:00:00Z"),
        endsAt: new Date("2026-10-27T12:45:00Z"),
        createdAt: new Date("2026-10-20T11:30:00Z"),
      },
    });
    expect((await panel.attendance(clinicId, now)).month).toMatchObject({
      noShowNotices: 1,
      rebooked: 1,
    });
    await db.appointment.delete({ where: { id: again.id } });
    await db.appointment.delete({ where: { id: old.id } });
  });
});
