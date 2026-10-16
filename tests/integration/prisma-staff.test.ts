import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger.js";
import { StaffService, type StaffActor } from "../../src/staff/staff.js";
import { FieldCipher } from "../../src/privacy/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-10-19T12:00:00Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe.skipIf(!url)("StaffService (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "s".repeat(32));
  let db: PrismaClient;
  let staff: StaffService;
  let clinicId = "";
  let otherClinicId = "";
  let dentist: StaffActor;
  let receptionId = "";

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    staff = new StaffService({ db, cipher, logger: createLogger("silent") });
    clinicId = (await db.clinic.create({ data: { name: "Clínica Equipe" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Equipe" } })).id;
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.staffUser.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("creates the dentist's login on first access, only once", async () => {
    expect(await staff.hasUsers(clinicId)).toBe(false);
    await expect(
      staff.bootstrap(clinicId, { name: "Dra. Ana", email: "ana@", password: "x" }, NOW),
    ).rejects.toMatchObject({ status: 422 });
    dentist = await staff.bootstrap(
      clinicId,
      { name: "Dra. Ana", email: " Ana@Clinica.test ", password: "senha-da-dentista" },
      NOW,
    );
    expect(dentist).toMatchObject({ name: "Dra. Ana", role: "DENTIST" });
    const raw = await db.staffUser.findUniqueOrThrow({ where: { id: dentist.id } });
    expect(raw.emailEncrypted).not.toContain("clinica");
    expect(raw.passwordHash).not.toContain("senha");
    await expect(
      staff.bootstrap(
        clinicId,
        { name: "Outra", email: "outra@clinica.test", password: "senha-da-outra" },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("creates the clinic on a fresh install", async () => {
    const fresh = `clinica_nova_${Date.now()}`;
    const ana = await staff.bootstrap(
      fresh,
      { name: "Dra. Ana", email: "ana@clinica.test", password: "senha-da-dentista" },
      NOW,
    );
    expect(await db.clinic.findUnique({ where: { id: fresh } })).toMatchObject({
      name: "Minha clínica",
    });
    expect((await db.staffUser.findUniqueOrThrow({ where: { id: ana.id } })).lastLoginAt).toEqual(
      NOW,
    );
    await db.staffUser.deleteMany({ where: { clinicId: fresh } });
    await db.clinic.delete({ where: { id: fresh } });
  });

  it("lets only the dentist register the staff", async () => {
    const created = await staff.create(
      clinicId,
      dentist,
      {
        name: "Bia Recepção",
        email: "bia@clinica.test",
        role: "RECEPTION",
        password: "senha-da-recepcao",
      },
      NOW,
    );
    receptionId = created.id;
    const bia = (await staff.actor(clinicId, receptionId))!;
    expect(bia).toEqual({ id: receptionId, name: "Bia Recepção", role: "RECEPTION" });
    await expect(
      staff.create(
        clinicId,
        bia,
        { name: "Caio", email: "caio@clinica.test", role: "RECEPTION", password: "senha-do-caio" },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      staff.create(
        clinicId,
        dentist,
        { name: "Bia 2", email: "BIA@clinica.test", role: "RECEPTION", password: "senha-da-bia2" },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await staff.list(clinicId)).toEqual([
      expect.objectContaining({ name: "Bia Recepção", email: "bia@clinica.test", active: true }),
      expect.objectContaining({ name: "Dra. Ana", email: "ana@clinica.test", role: "DENTIST" }),
    ]);
    expect(await staff.list(otherClinicId)).toEqual([]);
    expect(await staff.actor(otherClinicId, receptionId)).toBeNull();
  });

  it("logs in by e-mail and password, any case, only in the right clinic", async () => {
    const ok = { email: "BIA@clinica.test", password: "senha-da-recepcao" };
    expect(await staff.login(clinicId, ok, NOW)).toMatchObject({ id: receptionId });
    expect(
      (await db.staffUser.findUniqueOrThrow({ where: { id: receptionId } })).lastLoginAt,
    ).toEqual(NOW);
    for (const bad of [
      { email: "bia@clinica.test", password: "senha-errada-123" },
      { email: "ninguem@clinica.test", password: "senha-da-recepcao" },
      { email: 1 },
    ])
      await expect(staff.login(clinicId, bad, NOW)).rejects.toMatchObject({ status: 401 });
    await expect(staff.login(otherClinicId, ok, NOW)).rejects.toMatchObject({ status: 401 });
  });

  it("locks the login after five wrong passwords in a row", async () => {
    const wrong = { email: "bia@clinica.test", password: "senha-errada-123" };
    const right = { email: "bia@clinica.test", password: "senha-da-recepcao" };
    await staff.login(clinicId, right, NOW); // resets the earlier failure
    for (let i = 0; i < 4; i++)
      await expect(staff.login(clinicId, wrong, NOW)).rejects.toMatchObject({ status: 401 });
    await expect(staff.login(clinicId, wrong, NOW)).rejects.toMatchObject({
      status: 423,
      message: "Muitas tentativas erradas. Tente de novo em 15 minutos.",
    });
    await expect(staff.login(clinicId, right, later(14))).rejects.toMatchObject({ status: 423 });
    expect(await staff.login(clinicId, right, later(16))).toMatchObject({ id: receptionId });
  });

  it("resets and changes passwords", async () => {
    const bia = (await staff.actor(clinicId, receptionId))!;
    await expect(
      staff.resetPassword(clinicId, bia, dentist.id, { password: "tomei-a-conta" }),
    ).rejects.toMatchObject({ status: 403 });
    await staff.resetPassword(clinicId, dentist, receptionId, { password: "nova-senha-bia" });
    await expect(
      staff.changeOwnPassword(clinicId, bia, { current: "errada", password: "outra-senha-bia" }),
    ).rejects.toMatchObject({ status: 422 });
    await staff.changeOwnPassword(clinicId, bia, {
      current: "nova-senha-bia",
      password: "minha-senha-bia",
    });
    expect(
      await staff.login(clinicId, { email: "bia@clinica.test", password: "minha-senha-bia" }, NOW),
    ).toMatchObject({ id: receptionId });
  });

  it("deactivates a login at once, but never the last dentist", async () => {
    await staff.setActive(clinicId, dentist, receptionId, { active: false });
    expect(await staff.actor(clinicId, receptionId)).toBeNull();
    await expect(
      staff.login(clinicId, { email: "bia@clinica.test", password: "minha-senha-bia" }, NOW),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      staff.setActive(clinicId, dentist, dentist.id, { active: false }),
    ).rejects.toMatchObject({ status: 409 });
    await staff.setActive(clinicId, dentist, receptionId, { active: true });
    expect(await staff.actor(clinicId, receptionId)).not.toBeNull();
  });
});
