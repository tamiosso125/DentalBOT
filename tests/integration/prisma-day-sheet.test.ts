import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger.js";
import { DaySheetError, DaySheets } from "../../src/panel/day-sheet.js";
import { FieldCipher } from "../../src/privacy/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const at = (iso: string) => new Date(iso);

describe.skipIf(!url)("DaySheets (Postgres)", () => {
  let db: PrismaClient;
  let sheets: DaySheets;
  let clinicId = "";
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "m".repeat(32));

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    sheets = new DaySheets({ db, cipher, logger: createLogger("silent") });
    clinicId = (await db.clinic.create({ data: { name: "Clínica Agenda do Dia" } })).id;
    const plan = await db.insurancePlan.create({ data: { clinicId, name: "Odontoprev" } });
    const maria = await db.patient.create({
      data: {
        clinicId,
        name: "Maria Folha",
        phoneHash: "h5511900000161",
        phoneEncrypted: "x",
        insurancePlanId: plan.id,
      },
    });
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Ana" } })).id;
    const procedureId = (
      await db.procedure.create({ data: { clinicId, name: "Limpeza", durationMinutes: 30 } })
    ).id;
    const appt = (startsAt: string, status: "CONFIRMED" | "CANCELLED") =>
      db.appointment.create({
        data: {
          clinicId,
          patientId: maria.id,
          dentistId,
          procedureId,
          startsAt: at(startsAt),
          endsAt: at(startsAt.replace(":00:00Z", ":30:00Z")),
          status,
        },
      });
    await appt("2026-10-20T12:00:00Z", "CONFIRMED");
    await appt("2026-10-20T14:00:00Z", "CANCELLED");
    await appt("2026-10-21T12:00:00Z", "CONFIRMED");
    await db.medicalHistory.create({
      data: {
        clinicId,
        patientId: maria.id,
        dataEncrypted: cipher.encrypt(JSON.stringify({ allergies: "penicilina" })),
      },
    });
  });

  afterAll(async () => {
    await db.medicalHistory.deleteMany({ where: { clinicId } });
    await db.appointment.deleteMany({ where: { clinicId } });
    await db.patient.deleteMany({ where: { clinicId } });
    await db.insurancePlan.deleteMany({ where: { clinicId } });
    await db.procedure.deleteMany({ where: { clinicId } });
    await db.dentist.deleteMany({ where: { clinicId } });
    await db.clinic.delete({ where: { id: clinicId } });
    await db.$disconnect();
  });

  it("renders the day's sheet, with and without appointments", async () => {
    const pdf = await sheets.pdf(clinicId, "2026-10-20");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await sheets.pdf(clinicId, "2026-11-30")).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("lists the day's appointments with plan and alerts, cancelled ones left out", async () => {
    const d = await sheets.data(clinicId, "2026-10-20");
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0]).toMatchObject({
      patientName: "Maria Folha",
      procedureName: "Limpeza",
      plan: "Odontoprev",
      status: "CONFIRMED",
      alerts: ["Alergia: penicilina"],
    });
    expect((await sheets.data(clinicId, "2026-10-21")).rows).toHaveLength(1);
  });

  it("404 for an unknown clinic", async () => {
    await expect(sheets.pdf("nope", "2026-10-20")).rejects.toBeInstanceOf(DaySheetError);
  });
});
