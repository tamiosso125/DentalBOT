import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger.js";
import { MedicalHistories } from "../../src/panel/medical-history.js";
import { PrismaPanelQueries } from "../../src/panel/panel-queries.js";
import { PrismaPatientRecords } from "../../src/panel/patient-record.js";
import { FieldCipher } from "../../src/privacy/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-19T12:00:00Z");

describe.skipIf(!url)("MedicalHistories (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "m".repeat(32));
  let db: PrismaClient;
  let histories: MedicalHistories;
  let clinicId = "";
  let otherClinicId = "";
  let patientId = "";
  let anonymizedId = "";
  let staffUserId = "";
  let appointmentId = "";

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    histories = new MedicalHistories({ db, cipher, logger: createLogger("silent") });
    clinicId = (await db.clinic.create({ data: { name: "Clínica Anamnese" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Anamnese" } })).id;
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
    patientId = await patient("Maria Anamnese", "5511900000131");
    anonymizedId = await patient("Paciente anonimizado", "5511900000132", at("2026-10-01"));
    staffUserId = (
      await db.staffUser.create({
        data: {
          clinicId,
          name: "Dra. Ana",
          role: "DENTIST",
          emailHash: cipher.hash("ana@clinica.test"),
          emailEncrypted: cipher.encrypt("ana@clinica.test"),
          passwordHash: "x",
        },
      })
    ).id;
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Ana" } })).id;
    const procedureId = (
      await db.procedure.create({ data: { clinicId, name: "Extração", durationMinutes: 60 } })
    ).id;
    appointmentId = (
      await db.appointment.create({
        data: {
          clinicId,
          patientId,
          dentistId,
          procedureId,
          startsAt: at("2026-10-20T12:00:00Z"),
          endsAt: at("2026-10-20T13:00:00Z"),
        },
      })
    ).id;
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.medicalHistory.deleteMany({ where: { clinicId: id } });
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.staffUser.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("keeps every version encrypted, newest first, with who filled it in", async () => {
    expect(await histories.view(clinicId, patientId)).toEqual({ versions: [], alerts: [] });
    await histories.save(
      clinicId,
      patientId,
      { allergies: "", medications: "Losartana", conditions: ["HYPERTENSION"] },
      at("2026-10-01T12:00:00Z"),
    );
    const second = await histories.save(
      clinicId,
      patientId,
      { allergies: "Penicilina", medications: "Losartana", anticoagulant: true },
      at("2026-10-10T12:00:00Z"),
      staffUserId,
    );
    const raw = await db.medicalHistory.findUniqueOrThrow({ where: { id: second.id } });
    expect(raw.dataEncrypted).not.toContain("Penicilina");

    const view = await histories.view(clinicId, patientId);
    expect(view.alerts).toEqual(["Alergia: Penicilina", "Usa anticoagulante"]);
    expect(view.versions.map((v) => [v.at, v.staffName, v.data.allergies])).toEqual([
      ["2026-10-10T12:00:00.000Z", "Dra. Ana", "Penicilina"],
      ["2026-10-01T12:00:00.000Z", null, null],
    ]);
    expect(view.versions[1]!.data.conditions).toEqual(["HYPERTENSION"]);
    expect(await histories.view(otherClinicId, patientId)).toEqual({ versions: [], alerts: [] });
  });

  it("refuses an invalid form, another clinic's patient and an anonymized one", async () => {
    for (const bad of [{ diagnosis: "x" }, { notes: "x".repeat(1001) }, { pregnant: "sim" }])
      await expect(histories.save(clinicId, patientId, bad, NOW)).rejects.toMatchObject({
        status: 422,
      });
    await expect(histories.save(otherClinicId, patientId, {}, NOW)).rejects.toMatchObject({
      status: 404,
    });
    await expect(histories.save(clinicId, anonymizedId, {}, NOW)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("shows the alerts on the patient record and on the appointment", async () => {
    const record = (await new PrismaPatientRecords(db, cipher).record(clinicId, patientId, NOW))!;
    expect(record.medicalAlerts).toEqual(["Alergia: Penicilina", "Usa anticoagulante"]);
    expect(record.medicalHistoryAt).toBe("2026-10-10T12:00:00.000Z");
    const empty = (await new PrismaPatientRecords(db, cipher).record(clinicId, anonymizedId, NOW))!;
    expect(empty).toMatchObject({ medicalAlerts: [], medicalHistoryAt: null });
    const appt = await new PrismaPanelQueries(db, cipher).appointment(clinicId, appointmentId);
    expect(appt!.medicalAlerts).toEqual(["Alergia: Penicilina", "Usa anticoagulante"]);
  });
});
