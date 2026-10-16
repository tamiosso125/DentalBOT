import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InsuranceAuthorizations } from "../../src/insurance/authorizations.js";
import { PrismaInsuranceRepository } from "../../src/insurance/prisma-insurance.js";
import { InMemoryConversationStore } from "../../src/conversation/store.js";
import { silentLogger } from "../../src/lib/logger.js";
import { FieldCipher } from "../../src/privacy/index.js";
import { prismaAgendaFor } from "../../src/scheduling/prisma-agenda.js";
import { SandboxChannel } from "../../src/whatsapp/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
/** Wednesday 21/10, 10:00 in São Paulo. */
const VISIT = new Date("2026-10-21T13:00:00Z");
const NOW = new Date("2026-10-19T15:00:00Z");
const PHONES = { maria: "5511900000086", joao: "5511900000087" };

describe.skipIf(!url)("PrismaInsuranceRepository (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "i".repeat(32));
  let db: PrismaClient;
  let service: InsuranceAuthorizations;
  let channel: SandboxChannel;
  let clinicId = "";
  let otherClinicId = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    clinicId = (await db.clinic.create({ data: { name: "Clínica Convênio" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Clínica" } })).id;
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Convênio" } })).id;
    const proc = (name: string, priceCents: number | null) =>
      db.procedure.create({ data: { clinicId, name, durationMinutes: 30, priceCents } });
    ids.extracao = (await proc("Extração simples", 30000)).id;
    ids.limpeza = (await proc("Limpeza", 25000)).id;
    ids.plan = (
      await db.insurancePlan.create({
        data: {
          clinicId,
          name: "Odontoprev",
          coverages: {
            create: [
              { procedureId: ids.extracao, requiresAuthorization: true },
              { procedureId: ids.limpeza, requiresAuthorization: false },
            ],
          },
        },
      })
    ).id;
    const agenda = (await prismaAgendaFor(db, cipher, clinicId))!;
    ids.maria = (
      await agenda.cadastrarPaciente({ name: "Maria Convênio", phone: PHONES.maria })
    ).id;
    ids.joao = (await agenda.cadastrarPaciente({ name: "João Particular", phone: PHONES.joao })).id;
    const appt = async (patientId: string, procedureId: string, startsAt: Date) =>
      (
        await db.appointment.create({
          data: {
            clinicId,
            patientId,
            dentistId,
            procedureId,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 1800_000),
          },
        })
      ).id;
    ids.mariaExtracao = await appt(ids.maria, ids.extracao, VISIT);
    await appt(ids.maria, ids.limpeza, new Date("2026-10-22T13:00:00Z"));
    await appt(ids.joao, ids.extracao, new Date("2026-10-23T13:00:00Z"));
    channel = new SandboxChannel();
    service = new InsuranceAuthorizations({
      repo: new PrismaInsuranceRepository(db, cipher),
      channel,
      store: new InMemoryConversationStore({ id: clinicId, name: "Clínica Convênio" }),
      logger: silentLogger,
    });
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.insuranceAuthorization.deleteMany({ where: { clinicId: id } });
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.insuranceCoverage.deleteMany({ where: { insurancePlan: { clinicId: id } } });
      await db.insurancePlan.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("stores the card encrypted and lists only appointments that need authorization", async () => {
    expect(await service.register(clinicId, ids.maria!, "Odontoprev", "123.456.789")).toEqual({
      plan: "Odontoprev",
    });
    const stored = await db.patient.findUniqueOrThrow({ where: { id: ids.maria } });
    expect(stored.insuranceCardEncrypted).not.toContain("123456789");
    expect(await service.requiresAuthorization(clinicId, ids.maria!, ids.extracao!)).toBe(true);
    expect(await service.requiresAuthorization(clinicId, ids.maria!, ids.limpeza!)).toBe(false);
    expect(await service.register(otherClinicId, ids.maria!, "Odontoprev", "123456")).toMatchObject(
      { error: "plan" },
    );

    const list = await service.list(clinicId, NOW);
    expect(list.pending).toEqual([
      expect.objectContaining({
        appointmentId: ids.mariaExtracao,
        patientName: "Maria Convênio",
        card: "123456789",
        planName: "Odontoprev",
        patientPhone: "***0086",
      }),
    ]);
    expect((await service.list(otherClinicId, NOW)).pending).toEqual([]);
  });

  it("records a denial once and lets the patient keep it as private", async () => {
    await expect(
      service.decide(otherClinicId, ids.mariaExtracao!, { authorized: false }, NOW),
    ).rejects.toMatchObject({ status: 404 });
    expect(await service.decide(clinicId, ids.mariaExtracao!, { authorized: false }, NOW)).toEqual({
      notified: true,
    });
    await expect(
      service.decide(clinicId, ids.mariaExtracao!, { authorized: true }, NOW),
    ).rejects.toMatchObject({ status: 409 });
    const auth = await db.insuranceAuthorization.findUniqueOrThrow({
      where: { appointmentId: ids.mariaExtracao },
    });
    expect(auth).toMatchObject({ status: "DENIED", notifiedAt: NOW, insurancePlanId: ids.plan });
    expect(channel.outbox).toEqual([
      expect.objectContaining({
        to: PHONES.maria,
        template: "convenio_negado",
        buttonPayloads: [`auth:${auth.id}:private`, "handoff"],
      }),
    ]);

    expect((await service.choosePrivate(clinicId, PHONES.joao, auth.id, NOW)).text).toContain(
      "Não encontrei",
    );
    expect((await service.choosePrivate(clinicId, PHONES.maria, auth.id, NOW)).text).toContain(
      "300,00",
    );
    expect((await service.choosePrivate(clinicId, PHONES.maria, auth.id, NOW)).text).toContain(
      "Já registramos",
    );
    const list = await service.list(clinicId, NOW);
    expect(list.pending).toEqual([]);
    expect(list.decided).toEqual([
      expect.objectContaining({ status: "DENIED", privateChosenAt: NOW.toISOString() }),
    ]);
  });

  it("the panel clears the plan and the card together", async () => {
    await service.setPatientInsurance(clinicId, ids.maria!, { planId: null });
    expect(await service.patientInsurance(clinicId, ids.maria!)).toEqual({
      planId: null,
      card: null,
      plans: [{ id: ids.plan, name: "Odontoprev" }],
    });
    // The decision keeps its plan and stays listed.
    expect((await service.list(clinicId, NOW)).decided).toHaveLength(1);
    await expect(
      service.setPatientInsurance(otherClinicId, ids.maria!, { planId: null }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
