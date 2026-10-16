import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/lib/logger.js";
import { PrismaConversationStore } from "../../src/conversation/prisma-store.js";
import { PrismaClinicSetup } from "../../src/panel/clinic-setup.js";
import { FieldCipher } from "../../src/privacy/index.js";
import { prismaAgendaFor } from "../../src/scheduling/prisma-agenda.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-10-19T12:00:00Z");

describe.skipIf(!url)("PrismaClinicSetup (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "z".repeat(32));
  // A fresh install: the clinic row does not exist until the first save.
  const clinicId = `clinic_setup_${randomBytes(4).toString("hex")}`;
  let db: PrismaClient;
  let setup: PrismaClinicSetup;
  let otherClinicId = "";
  let otherDentistId = "";
  let dentistId = "";
  let procedureId = "";

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    setup = new PrismaClinicSetup(db, silentLogger);
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Clínica" } })).id;
    otherDentistId = (
      await db.dentist.create({ data: { clinicId: otherClinicId, name: "Dr. Outro" } })
    ).id;
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.insuranceCoverage.deleteMany({ where: { insurancePlan: { clinicId: id } } });
      await db.insurancePlan.deleteMany({ where: { clinicId: id } });
      await db.scheduleBlock.deleteMany({ where: { dentist: { clinicId: id } } });
      await db.workingHours.deleteMany({ where: { dentist: { clinicId: id } } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.deleteMany({ where: { id } });
    }
    await db.$disconnect();
  });

  it("starts empty and asks for the clinic data before anything else", async () => {
    expect(await setup.view(clinicId, NOW)).toEqual({
      clinic: null,
      dentists: [],
      procedures: [],
      insurancePlans: [],
      blocks: [],
    });
    await expect(setup.createDentist(clinicId, { name: "Dra. Ana Exemplo" })).rejects.toMatchObject(
      { status: 409 },
    );
  });

  it("creates the clinic on the first save and updates it afterwards", async () => {
    await setup.saveClinic(clinicId, { name: "Clínica Sorriso", address: "" });
    await setup.saveClinic(clinicId, { name: "Clínica Sorriso", address: "Rua das Flores, 10" });
    expect((await setup.view(clinicId, NOW)).clinic).toEqual({
      name: "Clínica Sorriso",
      address: "Rua das Flores, 10",
      timeZone: "America/Sao_Paulo",
    });
    await expect(setup.saveClinic(clinicId, { name: "" })).rejects.toMatchObject({ status: 422 });
  });

  it("registers the dentist, hours and procedures the bot offers", async () => {
    dentistId = (await setup.createDentist(clinicId, { name: "Dra. Ana Exemplo", cro: "CRO-SP 1" }))
      .id;
    await setup.setWorkingHours(clinicId, dentistId, {
      hours: [
        { weekday: 1, startMinute: 13 * 60, endMinute: 18 * 60 },
        { weekday: 1, startMinute: 8 * 60, endMinute: 12 * 60 },
      ],
    });
    procedureId = (
      await setup.createProcedure(clinicId, {
        name: "Limpeza",
        durationMinutes: 60,
        priceCents: 250_00,
      })
    ).id;
    await setup.createProcedure(clinicId, {
      name: "Avaliação",
      durationMinutes: 30,
      priceCents: null,
    });
    await expect(
      setup.createProcedure(clinicId, { name: "Limpeza", durationMinutes: 30, priceCents: 0 }),
    ).rejects.toMatchObject({ status: 409 });

    const agenda = (await prismaAgendaFor(db, cipher, clinicId, { now: () => NOW }))!;
    expect(await agenda.listarProcedimentos()).toEqual([
      expect.objectContaining({ name: "Avaliação", priceCents: null }),
      expect.objectContaining({ id: procedureId, name: "Limpeza", priceCents: 250_00 }),
    ]);
    const slots = await agenda.listarHorarios({ procedureId, from: "2026-10-26", days: 1 });
    // Mon 8h-12h and 13h-18h, 60 min every 30 min: 7 + 9 slots.
    expect(slots).toHaveLength(16);
    expect(slots[0]!.startsAt).toEqual(new Date("2026-10-26T11:00:00Z"));
  });

  it("replaces the working hours and keeps them per clinic", async () => {
    await setup.setWorkingHours(clinicId, dentistId, {
      hours: [{ weekday: 2, startMinute: 9 * 60, endMinute: 12 * 60 }],
    });
    const view = await setup.view(clinicId, NOW);
    expect(view.dentists).toEqual([
      {
        id: dentistId,
        name: "Dra. Ana Exemplo",
        cro: "CRO-SP 1",
        active: true,
        workingHours: [{ weekday: 2, startMinute: 540, endMinute: 720 }],
      },
    ]);
    await expect(
      setup.setWorkingHours(clinicId, otherDentistId, { hours: [] }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      setup.setWorkingHours(clinicId, dentistId, {
        hours: [
          { weekday: 2, startMinute: 540, endMinute: 720 },
          { weekday: 2, startMinute: 700, endMinute: 900 },
        ],
      }),
    ).rejects.toMatchObject({ status: 422, message: "Os horários de terça se sobrepõem." });
    expect((await setup.view(clinicId, NOW)).dentists[0]!.workingHours).toHaveLength(1);
  });

  it("changes prices and takes procedures off the bot without deleting them", async () => {
    await setup.updateProcedure(clinicId, procedureId, {
      name: "Limpeza (profilaxia)",
      durationMinutes: 45,
      priceCents: 280_00,
      active: false,
      aftercareText: "  Evite café nas primeiras 2 horas.  ",
    });
    expect((await setup.view(clinicId, NOW)).procedures).toContainEqual({
      id: procedureId,
      name: "Limpeza (profilaxia)",
      durationMinutes: 45,
      priceCents: 280_00,
      active: false,
      aftercareText: "Evite café nas primeiras 2 horas.",
    });
    // Left out = unchanged; empty = no care instructions.
    await setup.updateProcedure(clinicId, procedureId, {
      name: "Limpeza (profilaxia)",
      durationMinutes: 45,
      priceCents: 280_00,
      active: false,
    });
    const kept = (await setup.view(clinicId, NOW)).procedures.find((p) => p.id === procedureId);
    expect(kept?.aftercareText).toBe("Evite café nas primeiras 2 horas.");
    await setup.updateProcedure(clinicId, procedureId, {
      name: "Limpeza (profilaxia)",
      durationMinutes: 45,
      priceCents: 280_00,
      active: false,
      aftercareText: " ",
    });
    const cleared = (await setup.view(clinicId, NOW)).procedures.find((p) => p.id === procedureId);
    expect(cleared?.aftercareText).toBeNull();
    await expect(
      setup.updateProcedure(clinicId, procedureId, {
        name: "Limpeza (profilaxia)",
        durationMinutes: 45,
        priceCents: 280_00,
        aftercareText: "x".repeat(601),
      }),
    ).rejects.toMatchObject({ status: 422 });
    const agenda = (await prismaAgendaFor(db, cipher, clinicId))!;
    expect((await agenda.listarProcedimentos()).map((p) => p.name)).toEqual(["Avaliação"]);
    await expect(
      setup.updateProcedure(otherClinicId, procedureId, {
        name: "X1",
        durationMinutes: 30,
        priceCents: 0,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await setup.updateProcedure(clinicId, procedureId, {
      name: "Limpeza (profilaxia)",
      durationMinutes: 45,
      priceCents: 280_00,
    });
  });

  it("blocks days off the agenda and counts the appointments already inside", async () => {
    await setup.setWorkingHours(clinicId, dentistId, {
      hours: [{ weekday: 4, startMinute: 8 * 60, endMinute: 12 * 60 }],
    });
    const patient = await db.patient.create({
      data: {
        clinicId,
        name: "Paciente Exemplo",
        phoneHash: cipher.hash("5511900000041"),
        phoneEncrypted: cipher.encrypt("5511900000041"),
      },
    });
    await db.appointment.create({
      data: {
        clinicId,
        patientId: patient.id,
        dentistId,
        procedureId,
        startsAt: new Date("2026-12-24T12:00:00Z"),
        endsAt: new Date("2026-12-24T12:45:00Z"),
      },
    });

    const block = await setup.createBlock(clinicId, {
      dentistId,
      fromDate: "2026-12-24",
      toDate: "2026-12-31",
      reason: "Recesso de fim de ano",
    });
    expect(block.appointments).toBe(1);
    const agenda = (await prismaAgendaFor(db, cipher, clinicId, { now: () => NOW }))!;
    const slots = (from: string) => agenda.listarHorarios({ procedureId, from, days: 1 });
    expect(await slots("2026-12-31")).toEqual([]);
    expect((await slots("2027-01-07")).length).toBeGreaterThan(0);

    const view = await setup.view(clinicId, NOW);
    expect(view.blocks).toEqual([
      {
        id: block.id,
        dentistId,
        dentistName: "Dra. Ana Exemplo",
        startsAt: "2026-12-24T03:00:00.000Z",
        endsAt: "2027-01-01T03:00:00.000Z",
        reason: "Recesso de fim de ano",
      },
    ]);
    // Past blocks leave the list.
    expect((await setup.view(clinicId, new Date("2027-01-02T00:00:00Z"))).blocks).toEqual([]);

    await expect(
      setup.createBlock(clinicId, {
        dentistId: otherDentistId,
        fromDate: "2026-12-24",
        toDate: "2026-12-24",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(setup.deleteBlock(otherClinicId, block.id)).rejects.toMatchObject({
      status: 404,
    });
    await setup.deleteBlock(clinicId, block.id);
    expect((await slots("2026-12-31")).length).toBeGreaterThan(0);
  });

  it("deactivates the dentist, which empties the bot's agenda", async () => {
    await setup.updateDentist(clinicId, dentistId, {
      name: "Dra. Ana Exemplo",
      cro: "",
      active: false,
    });
    const view = await setup.view(clinicId, NOW);
    expect(view.dentists[0]).toMatchObject({ cro: null, active: false });
    const agenda = (await prismaAgendaFor(db, cipher, clinicId, { now: () => NOW }))!;
    expect(await agenda.listarHorarios({ procedureId, from: "2027-01-07", days: 1 })).toEqual([]);
    await expect(
      setup.updateDentist(clinicId, otherDentistId, { name: "Dr. Invasor" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("registers what each plan covers, which the bot reads from the clinic profile", async () => {
    const planId = (await setup.createPlan(clinicId, { name: "Odontoprev" })).id;
    await expect(setup.createPlan(clinicId, { name: "Odontoprev" })).rejects.toMatchObject({
      status: 409,
    });
    const store = new PrismaConversationStore(db, cipher);
    // No coverage table yet: the bot must not claim anything.
    expect((await store.clinicProfile(clinicId))!.coverage).toEqual([]);

    await setup.setCoverage(clinicId, planId, {
      items: [{ procedureId, requiresAuthorization: true }],
    });
    expect((await setup.view(clinicId, NOW)).insurancePlans).toEqual([
      { id: planId, name: "Odontoprev", coverage: [{ procedureId, requiresAuthorization: true }] },
    ]);
    expect(await store.clinicProfile(clinicId)).toMatchObject({
      insurancePlans: ["Odontoprev"],
      coverage: [{ plan: "Odontoprev", procedureId, requiresAuthorization: true }],
    });

    const otherProcedure = (
      await db.procedure.create({
        data: { clinicId: otherClinicId, name: "Limpeza", durationMinutes: 30 },
      })
    ).id;
    await expect(
      setup.setCoverage(clinicId, planId, { items: [{ procedureId: otherProcedure }] }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      setup.setCoverage(clinicId, planId, { items: [{ procedureId }, { procedureId }] }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(setup.setCoverage(otherClinicId, planId, { items: [] })).rejects.toMatchObject({
      status: 404,
    });

    await setup.updatePlan(clinicId, planId, { name: "Odontoprev Empresarial" });
    await setup.setCoverage(clinicId, planId, { items: [] });
    expect((await setup.view(clinicId, NOW)).insurancePlans).toEqual([
      { id: planId, name: "Odontoprev Empresarial", coverage: [] },
    ]);
  });
});
