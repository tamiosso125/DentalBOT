import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger.js";
import { ClinicalRecordError, ClinicalRecords } from "../../src/panel/clinical-record.js";
import { PrismaPatientRecords } from "../../src/panel/patient-record.js";
import { FieldCipher } from "../../src/privacy/index.js";
import type { StaffActor } from "../../src/staff/staff.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-21T12:00:00Z");

describe.skipIf(!url)("ClinicalRecords (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "c".repeat(32));
  let db: PrismaClient;
  let records: ClinicalRecords;
  let clinicId = "";
  let otherClinicId = "";
  let patientId = "";
  let otherPatientId = "";
  let anonymizedId = "";
  let doneId = "";
  let pendingId = "";
  let otherPatientApptId = "";
  let dentist: StaffActor;
  let reception: StaffActor;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    records = new ClinicalRecords({ db, cipher, logger: createLogger("silent") });
    clinicId = (await db.clinic.create({ data: { name: "Clínica Prontuário" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Prontuário" } })).id;
    const patient = async (name: string, phone: string, anonymizedAt?: Date) =>
      (
        await db.patient.create({
          data: {
            clinicId,
            name,
            phoneHash: cipher.hash(phone),
            phoneEncrypted: cipher.encrypt(phone),
            anonymizedAt,
          },
        })
      ).id;
    patientId = await patient("Maria Prontuário", "5511900000141");
    otherPatientId = await patient("João Prontuário", "5511900000142");
    anonymizedId = await patient("Paciente anonimizado", "5511900000143", at("2026-10-01"));
    const staff = async (name: string, role: "DENTIST" | "RECEPTION", mail: string) => {
      const u = await db.staffUser.create({
        data: {
          clinicId,
          name,
          role,
          emailHash: cipher.hash(mail),
          emailEncrypted: cipher.encrypt(mail),
          passwordHash: "x",
        },
      });
      return { id: u.id, name, role } satisfies StaffActor;
    };
    dentist = await staff("Dra. Ana", "DENTIST", "ana@prontuario.test");
    reception = await staff("Bia", "RECEPTION", "bia@prontuario.test");
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Ana" } })).id;
    const procedureId = (
      await db.procedure.create({ data: { clinicId, name: "Restauração", durationMinutes: 45 } })
    ).id;
    const appt = async (patient: string, status: "COMPLETED" | "CONFIRMED", day: string) =>
      (
        await db.appointment.create({
          data: {
            clinicId,
            patientId: patient,
            dentistId,
            procedureId,
            startsAt: at(`2026-10-${day}T12:00:00Z`),
            endsAt: at(`2026-10-${day}T12:45:00Z`),
            status,
          },
        })
      ).id;
    doneId = await appt(patientId, "COMPLETED", "20");
    pendingId = await appt(patientId, "CONFIRMED", "28");
    otherPatientApptId = await appt(otherPatientId, "COMPLETED", "20");
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.clinicalEntry.updateMany({ where: { clinicId: id }, data: { amendsId: null } });
      await db.clinicalEntry.deleteMany({ where: { clinicId: id } });
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.staffUser.deleteMany({ where: { clinicId: id } });
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
      if (err instanceof ClinicalRecordError) return err.status;
      throw err;
    }
    return 0;
  };

  it("signs an entry for an attended visit, encrypted, and an addendum after it", async () => {
    expect(await records.list(clinicId, patientId)).toEqual([]);
    const first = await records.add(
      clinicId,
      patientId,
      dentist,
      {
        appointmentId: doneId,
        performed: "Restauração em resina",
        teeth: ["36"],
        notes: "Sem dor",
      },
      at("2026-10-20T13:30:00Z"),
    );
    const addendum = await records.add(
      clinicId,
      patientId,
      dentist,
      { amendsId: first.id, performed: "Correção: o dente era o 37", teeth: ["37"] },
      NOW,
    );

    const raw = await db.clinicalEntry.findMany({ where: { patientId } });
    expect(raw).toHaveLength(2);
    for (const r of raw) expect(r.dataEncrypted).not.toContain("resina");
    const list = await records.list(clinicId, patientId);
    expect(list.map((e) => e.id)).toEqual([first.id, addendum.id]);
    expect(list[0]).toMatchObject({
      appointmentId: doneId,
      procedure: "Restauração",
      signedBy: "Dra. Ana",
      amendsId: null,
      data: { performed: "Restauração em resina", teeth: ["36"], notes: "Sem dor" },
    });
    expect(list[1]).toMatchObject({
      appointmentId: doneId,
      amendsId: first.id,
      data: { performed: "Correção: o dente era o 37", teeth: ["37"], notes: null },
    });
  });

  it("is written only by the dentist, for an attended visit of this patient", async () => {
    const body = { appointmentId: doneId, performed: "x" };
    expect(await status(records.add(clinicId, patientId, reception, body, NOW))).toBe(403);
    expect(
      await status(records.add(clinicId, patientId, dentist, { ...body, performed: " " }, NOW)),
    ).toBe(422);
    expect(await status(records.add(clinicId, patientId, dentist, { performed: "x" }, NOW))).toBe(
      422,
    );
    // Visit not attended yet.
    expect(
      await status(
        records.add(clinicId, patientId, dentist, { ...body, appointmentId: pendingId }, NOW),
      ),
    ).toBe(422);
    // Another patient's visit, another clinic's patient, an anonymized patient.
    expect(
      await status(
        records.add(
          clinicId,
          patientId,
          dentist,
          { ...body, appointmentId: otherPatientApptId },
          NOW,
        ),
      ),
    ).toBe(404);
    expect(await status(records.add(otherClinicId, patientId, dentist, body, NOW))).toBe(404);
    expect(await status(records.add(clinicId, anonymizedId, dentist, body, NOW))).toBe(404);
    expect(await records.list(otherClinicId, patientId)).toEqual([]);
  });

  it("an addendum needs an existing entry of the same patient and visit", async () => {
    const [first] = await records.list(clinicId, patientId);
    expect(
      await status(
        records.add(clinicId, patientId, dentist, { amendsId: "nope", performed: "x" }, NOW),
      ),
    ).toBe(404);
    expect(
      await status(
        records.add(
          clinicId,
          otherPatientId,
          dentist,
          { amendsId: first!.id, performed: "x" },
          NOW,
        ),
      ),
    ).toBe(404);
    expect(
      await status(
        records.add(
          clinicId,
          patientId,
          dentist,
          { amendsId: first!.id, appointmentId: pendingId, performed: "x" },
          NOW,
        ),
      ),
    ).toBe(422);
  });

  it("counts the entries on the patient record", async () => {
    const view = await new PrismaPatientRecords(db, cipher).record(clinicId, patientId, NOW);
    expect(view?.clinicalEntries).toBe(2);
    const other = await new PrismaPatientRecords(db, cipher).record(clinicId, otherPatientId, NOW);
    expect(other?.clinicalEntries).toBe(0);
  });
});
