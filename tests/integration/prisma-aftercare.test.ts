import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AFTERCARE_MESSAGES, AftercareService } from "../../src/aftercare/aftercare.js";
import { PrismaAftercareRepository } from "../../src/aftercare/prisma-aftercare.js";
import { InMemoryConversationStore } from "../../src/conversation/store.js";
import { silentLogger } from "../../src/lib/logger.js";
import { FieldCipher } from "../../src/privacy/index.js";
import { prismaAgendaFor } from "../../src/scheduling/prisma-agenda.js";
import { PrismaSurveyRepository } from "../../src/survey/prisma-survey.js";
import { SandboxChannel } from "../../src/whatsapp/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
/** Tuesday 20/10, 14:00 in São Paulo. */
const VISIT = new Date("2026-10-20T17:00:00Z");
/** Same day, 15:30: the front desk just marked "Compareceu". */
const AFTER_VISIT = new Date("2026-10-20T18:30:00Z");
/** Wednesday 21/10, 11:00 in São Paulo. */
const NEXT_DAY = new Date("2026-10-21T14:00:00Z");
const PHONES = { maria: "5511900000091", joao: "5511900000092" };

describe.skipIf(!url)("PrismaAftercareRepository (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "a".repeat(32));
  let db: PrismaClient;
  let repo: PrismaAftercareRepository;
  let service: AftercareService;
  let channel: SandboxChannel;
  let clinicId = "";
  let otherClinicId = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    repo = new PrismaAftercareRepository(db, cipher);
    clinicId = (await db.clinic.create({ data: { name: "Clínica Cuidados" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Clínica" } })).id;
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Cuidados" } })).id;
    const extraction = await db.procedure.create({
      data: {
        clinicId,
        name: "Extração simples",
        durationMinutes: 45,
        aftercareText: "Não cuspa nas primeiras 24 horas.\nPrefira alimentos frios.",
      },
    });
    const cleaning = await db.procedure.create({
      data: { clinicId, name: "Limpeza", durationMinutes: 45 },
    });
    const agenda = (await prismaAgendaFor(db, cipher, clinicId))!;
    ids.maria = (
      await agenda.cadastrarPaciente({ name: "Maria Cuidados", phone: PHONES.maria })
    ).id;
    ids.joao = (await agenda.cadastrarPaciente({ name: "João Cuidados", phone: PHONES.joao })).id;
    const appt = (patientId: string, procedureId: string, status: "COMPLETED" | "NO_SHOW") =>
      db.appointment.create({
        data: {
          clinicId,
          patientId,
          dentistId,
          procedureId,
          status,
          startsAt: VISIT,
          endsAt: new Date(VISIT.getTime() + 45 * 60_000),
        },
      });
    ids.mariaAppt = (await appt(ids.maria, extraction.id, "COMPLETED")).id;
    await appt(ids.joao, cleaning.id, "COMPLETED");
    await appt(ids.joao, extraction.id, "NO_SHOW");
    channel = new SandboxChannel();
    service = new AftercareService({
      repo,
      channel,
      store: new InMemoryConversationStore({ id: clinicId, name: "Clínica Cuidados" }),
      logger: silentLogger,
    });
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.aftercareFollowUp.deleteMany({ where: { clinicId: id } });
      await db.satisfactionSurvey.deleteMany({ where: { clinicId: id } });
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("sends the care text only for attended procedures that have one, once", async () => {
    const from = new Date(VISIT.getTime() - 1);
    expect(await repo.instructionCandidates(from, AFTER_VISIT, otherClinicId)).toEqual([]);
    expect(await service.run(AFTER_VISIT, clinicId)).toEqual({ instructions: 1, checkIns: 0 });
    expect(channel.outbox).toEqual([
      expect.objectContaining({
        to: PHONES.maria,
        template: "orientacoes_pos_procedimento",
        params: [
          "Maria",
          "Clínica Cuidados",
          "Extração simples",
          "Não cuspa nas primeiras 24 horas. Prefira alimentos frios.",
        ],
      }),
    ]);
    expect(await repo.instructionCandidates(from, AFTER_VISIT, clinicId)).toEqual([]);
    const f = await db.aftercareFollowUp.findUniqueOrThrow({
      where: { appointmentId: ids.mariaAppt },
    });
    ids.followUp = f.id;
    expect(
      await repo.create(
        {
          appointmentId: ids.mariaAppt!,
          clinicId,
          clinicName: "",
          clinicTimeZone: "America/Sao_Paulo",
          patientId: ids.maria!,
          patientName: "",
          phone: "",
          startsAt: VISIT,
          procedureName: "",
          aftercareText: "",
        },
        AFTER_VISIT,
      ),
    ).toBeNull();
  });

  it("checks in the next day once and holds the survey until the answer", async () => {
    const surveys = new PrismaSurveyRepository(db, cipher);
    const window = [new Date(VISIT.getTime() - 1), NEXT_DAY] as const;
    const surveyed = async () =>
      (await surveys.candidates(...window, clinicId)).map((c) => c.appointmentId);
    expect(await surveyed()).not.toContain(ids.mariaAppt);

    expect(await service.run(NEXT_DAY, clinicId)).toEqual({ instructions: 0, checkIns: 1 });
    expect(channel.outbox.at(-1)).toMatchObject({
      template: "acompanhamento_pos_procedimento",
      params: ["Maria", "Extração simples", "Clínica Cuidados"],
      buttonPayloads: [`care:${ids.followUp}:ok`, `care:${ids.followUp}:help`],
    });
    expect(await repo.claimCheckIn(ids.followUp!, NEXT_DAY)).toBe(false);
    expect(await repo.get(otherClinicId, ids.followUp!)).toBeNull();
    expect(await service.answer(clinicId, PHONES.joao, ids.followUp!, "OK", NEXT_DAY)).toEqual({
      text: AFTERCARE_MESSAGES.notFound,
    });

    expect(await service.answer(clinicId, PHONES.maria, ids.followUp!, "OK", NEXT_DAY)).toEqual({
      text: AFTERCARE_MESSAGES.ok,
    });
    expect(await surveyed()).toContain(ids.mariaAppt);

    const help = await service.answer(clinicId, PHONES.maria, ids.followUp!, "HELP", NEXT_DAY);
    expect(help).toEqual({ text: AFTERCARE_MESSAGES.help, handoff: "aftercare:help" });
    expect(await surveyed()).not.toContain(ids.mariaAppt);
  });

  it("summarizes the month and the help requests for the clinic only", async () => {
    const summary = await service.summary(clinicId, new Date("2026-10-22T12:00:00Z"));
    expect(summary.month).toEqual({ sent: 1, checkIns: 1, ok: 0, help: 1 });
    expect(summary.help).toEqual([
      expect.objectContaining({
        followUpId: ids.followUp,
        patientName: "Maria Cuidados",
        patientPhone: "***0091",
        procedureName: "Extração simples",
        appointmentAt: VISIT.toISOString(),
      }),
    ]);
    expect((await service.summary(otherClinicId, NEXT_DAY)).month.sent).toBe(0);
  });

  it("gives the appointment back after a failed send", async () => {
    await db.aftercareFollowUp.deleteMany({ where: { clinicId } });
    const send = channel.send.bind(channel);
    channel.send = async () => {
      throw new Error("network");
    };
    expect(await service.run(AFTER_VISIT, clinicId)).toEqual({ instructions: 0, checkIns: 0 });
    expect(await db.aftercareFollowUp.count({ where: { clinicId } })).toBe(0);
    channel.send = send;
    expect(await service.run(AFTER_VISIT, clinicId)).toEqual({ instructions: 1, checkIns: 0 });
    const f = await db.aftercareFollowUp.findFirstOrThrow({ where: { clinicId } });
    expect(await repo.claimCheckIn(f.id, NEXT_DAY)).toBe(true);
    await repo.releaseCheckIn(f.id);
    expect(
      (await db.aftercareFollowUp.findUniqueOrThrow({ where: { id: f.id } })).checkInSentAt,
    ).toBeNull();
  });
});
