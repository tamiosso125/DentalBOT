import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger.js";
import { PatientNoteError, PatientNotes } from "../../src/panel/patient-notes.js";
import { FieldCipher } from "../../src/privacy/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const at = (iso: string) => new Date(iso);

describe.skipIf(!url)("PatientNotes (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "n".repeat(32));
  let db: PrismaClient;
  let notes: PatientNotes;
  let clinicId = "";
  let otherClinicId = "";
  let patientId = "";
  let anonymizedId = "";

  const patient = (name: string, phone: string, anonymizedAt?: Date) =>
    db.patient.create({
      data: {
        clinicId,
        name,
        phoneHash: cipher.hash(phone),
        phoneEncrypted: cipher.encrypt(phone),
        anonymizedAt,
      },
    });

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    notes = new PatientNotes({ db, cipher, logger: createLogger("silent") });
    clinicId = (await db.clinic.create({ data: { name: "Clínica Notas" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Notas" } })).id;
    patientId = (await patient("Maria Notas", "5511900000111")).id;
    anonymizedId = (await patient("Paciente anonimizado", "5511900000112", at("2026-10-01"))).id;
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.patientNote.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("stores the text encrypted and lists newest first", async () => {
    const first = await notes.add(
      clinicId,
      patientId,
      { author: "RECEPTION", text: "  Prefere horários de manhã  " },
      at("2026-10-16T12:00:00Z"),
    );
    await notes.add(
      clinicId,
      patientId,
      { author: "DENTIST", text: "Tem medo de agulha" },
      at("2026-10-16T13:00:00Z"),
    );
    const raw = await db.patientNote.findUniqueOrThrow({ where: { id: first.id } });
    expect(raw.textEncrypted).not.toContain("manhã");
    expect(await notes.list(clinicId, patientId)).toEqual([
      expect.objectContaining({ author: "DENTIST", text: "Tem medo de agulha" }),
      {
        id: first.id,
        author: "RECEPTION",
        text: "Prefere horários de manhã",
        createdAt: "2026-10-16T12:00:00.000Z",
      },
    ]);
    expect(await notes.list(otherClinicId, patientId)).toEqual([]);
  });

  it("refuses an empty or too long note, another clinic's patient and an anonymized one", async () => {
    const now = at("2026-10-16T14:00:00Z");
    for (const input of [
      { author: "RECEPTION", text: "   " },
      { author: "RECEPTION", text: "x".repeat(1001) },
      { author: "PATIENT", text: "Oi" },
    ])
      await expect(notes.add(clinicId, patientId, input, now)).rejects.toMatchObject({
        status: 422,
      });
    const ok = { author: "RECEPTION", text: "Oi" };
    await expect(notes.add(otherClinicId, patientId, ok, now)).rejects.toBeInstanceOf(
      PatientNoteError,
    );
    await expect(notes.add(clinicId, anonymizedId, ok, now)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("deletes a note only within the clinic and patient", async () => {
    const [newest] = await notes.list(clinicId, patientId);
    await expect(notes.remove(otherClinicId, patientId, newest!.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(notes.remove(clinicId, anonymizedId, newest!.id)).rejects.toMatchObject({
      status: 404,
    });
    await notes.remove(clinicId, patientId, newest!.id);
    expect((await notes.list(clinicId, patientId)).map((n) => n.text)).toEqual([
      "Prefere horários de manhã",
    ]);
  });
});
