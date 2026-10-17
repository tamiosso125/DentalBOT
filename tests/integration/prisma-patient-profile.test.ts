import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger.js";
import { PatientProfileError, PatientProfiles } from "../../src/panel/patient-profile.js";
import { FieldCipher } from "../../src/privacy/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-10-17T12:00:00Z");
const CPF = "529.982.247-25";
const OTHER_CPF = "111.444.777-35";

describe.skipIf(!url)("PatientProfiles (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "p".repeat(32));
  let db: PrismaClient;
  let profiles: PatientProfiles;
  let clinicId = "";
  let otherClinicId = "";
  let mariaId = "";
  let joaoId = "";
  let anonymizedId = "";

  const patient = (clinic: string, name: string, phone: string, anonymizedAt?: Date) =>
    db.patient.create({
      data: {
        clinicId: clinic,
        name,
        phoneHash: cipher.hash(phone),
        phoneEncrypted: cipher.encrypt(phone),
        anonymizedAt,
      },
    });
  const fail = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PatientProfileError);
    return err as PatientProfileError;
  };

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    profiles = new PatientProfiles({ db, cipher, logger: createLogger("silent") });
    clinicId = (await db.clinic.create({ data: { name: "Clínica Cadastro" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Cadastro" } })).id;
    mariaId = (await patient(clinicId, "Maria", "5511900000201")).id;
    joaoId = (await patient(clinicId, "Joao", "5511900000202")).id;
    anonymizedId = (await patient(clinicId, "Anon", "5511900000203", NOW)).id;
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("changes name and birth date, accepting both date formats", async () => {
    await profiles.update(
      clinicId,
      mariaId,
      { name: "  Maria Souza ", birthDate: "15/03/1990" },
      NOW,
    );
    const p = await db.patient.findUniqueOrThrow({ where: { id: mariaId } });
    expect(p.name).toBe("Maria Souza");
    expect(p.birthDate?.toISOString().slice(0, 10)).toBe("1990-03-15");
  });

  it("stores the CPF as hash plus encrypted digits, and leaves it alone when absent", async () => {
    await profiles.update(clinicId, mariaId, { cpf: CPF }, NOW);
    let p = await db.patient.findUniqueOrThrow({ where: { id: mariaId } });
    expect(p.cpfHash).toBe(cipher.hash("52998224725"));
    expect(cipher.decrypt(p.cpfEncrypted!)).toBe("52998224725");
    expect(JSON.stringify(p)).not.toContain("52998224725");

    await profiles.update(clinicId, mariaId, { name: "Maria S." }, NOW);
    p = await db.patient.findUniqueOrThrow({ where: { id: mariaId } });
    expect(p.cpfHash).toBe(cipher.hash("52998224725"));
  });

  it("clears the birth date and the CPF with null", async () => {
    await profiles.update(clinicId, mariaId, { birthDate: null, cpf: null }, NOW);
    const p = await db.patient.findUniqueOrThrow({ where: { id: mariaId } });
    expect([p.birthDate, p.cpfHash, p.cpfEncrypted]).toEqual([null, null, null]);
  });

  it("refuses a CPF already used by another patient of the clinic, but not of another clinic", async () => {
    await profiles.update(clinicId, mariaId, { cpf: CPF }, NOW);
    expect((await fail(profiles.update(clinicId, joaoId, { cpf: CPF }, NOW))).status).toBe(409);
    // Saving the same CPF on the same patient is fine.
    await profiles.update(clinicId, mariaId, { cpf: CPF }, NOW);

    const elsewhere = await patient(otherClinicId, "Ana", "5511900000204");
    await profiles.update(otherClinicId, elsewhere.id, { cpf: CPF }, NOW);
    await profiles.update(clinicId, joaoId, { cpf: OTHER_CPF }, NOW);
  });

  it("validates CPF, birth date and name, and changes nothing when it refuses", async () => {
    const bad: unknown[] = [
      { cpf: "111.111.111-11" },
      { cpf: "123" },
      { birthDate: "31/02/1990" },
      { birthDate: "2026-10-18" },
      { birthDate: "1850-01-01" },
      { name: "A" },
      { name: "Maria", phone: "5511900000999" },
      {},
    ];
    for (const input of bad)
      expect((await fail(profiles.update(clinicId, mariaId, input, NOW))).status).toBe(422);
    const p = await db.patient.findUniqueOrThrow({ where: { id: mariaId } });
    expect(p.name).toBe("Maria S.");
  });

  it("404s another clinic's patient and refuses an anonymized one", async () => {
    expect(
      (await fail(profiles.update(otherClinicId, mariaId, { name: "Hack" }, NOW))).status,
    ).toBe(404);
    expect(
      (await fail(profiles.update(clinicId, anonymizedId, { name: "Volta" }, NOW))).status,
    ).toBe(422);
    expect((await db.patient.findUniqueOrThrow({ where: { id: anonymizedId } })).name).toBe("Anon");
  });
});
