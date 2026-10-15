import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPanelQueries } from "../../src/panel/panel-queries.js";
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
});
