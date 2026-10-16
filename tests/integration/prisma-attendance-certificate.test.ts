import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger.js";
import {
  AttendanceCertificateError,
  AttendanceCertificates,
} from "../../src/panel/attendance-certificate.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-21T12:00:00Z");

describe.skipIf(!url)("AttendanceCertificates (Postgres)", () => {
  let db: PrismaClient;
  let certificates: AttendanceCertificates;
  let clinicId = "";
  let otherClinicId = "";
  let doneId = "";
  let confirmedId = "";
  let anonymizedApptId = "";

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    certificates = new AttendanceCertificates({ db, logger: createLogger("silent") });
    clinicId = (await db.clinic.create({ data: { name: "Clínica Atestado", address: "Rua A, 1" } }))
      .id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Atestado" } })).id;
    const patient = async (name: string, phone: string, anonymizedAt?: Date) =>
      (
        await db.patient.create({
          data: { clinicId, name, phoneHash: `h${phone}`, phoneEncrypted: "x", anonymizedAt },
        })
      ).id;
    const maria = await patient("Maria Atestado", "5511900000151");
    const anon = await patient("Paciente anonimizado", "5511900000152", at("2026-10-01"));
    const dentistId = (
      await db.dentist.create({ data: { clinicId, name: "Dra. Ana", cro: "CRO-SP 1" } })
    ).id;
    const procedureId = (
      await db.procedure.create({ data: { clinicId, name: "Extração", durationMinutes: 30 } })
    ).id;
    const appt = async (patientId: string, status: "COMPLETED" | "CONFIRMED", day: string) =>
      (
        await db.appointment.create({
          data: {
            clinicId,
            patientId,
            dentistId,
            procedureId,
            startsAt: at(`2026-10-${day}T12:00:00Z`),
            endsAt: at(`2026-10-${day}T12:30:00Z`),
            status,
          },
        })
      ).id;
    doneId = await appt(maria, "COMPLETED", "20");
    confirmedId = await appt(maria, "CONFIRMED", "28");
    anonymizedApptId = await appt(anon, "COMPLETED", "20");
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  const status = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      if (err instanceof AttendanceCertificateError) return err.status;
      throw err;
    }
    return 0;
  };

  it("renders the PDF for an attended visit", async () => {
    const pdf = await certificates.pdf(clinicId, doneId, NOW);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("refuses a visit that was not attended, an anonymized patient and another clinic", async () => {
    expect(await status(certificates.pdf(clinicId, confirmedId, NOW))).toBe(422);
    expect(await status(certificates.pdf(clinicId, anonymizedApptId, NOW))).toBe(422);
    expect(await status(certificates.pdf(otherClinicId, doneId, NOW))).toBe(404);
    expect(await status(certificates.pdf(clinicId, "nope", NOW))).toBe(404);
  });
});
