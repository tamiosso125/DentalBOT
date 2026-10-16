import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryConversationStore } from "../../src/conversation/store.js";
import { silentLogger } from "../../src/lib/logger.js";
import { FieldCipher } from "../../src/privacy/index.js";
import { prismaAgendaFor } from "../../src/scheduling/prisma-agenda.js";
import { PrismaSurveyRepository } from "../../src/survey/prisma-survey.js";
import { SURVEY_MESSAGES, SurveyService, type SurveyCandidate } from "../../src/survey/survey.js";
import { SandboxChannel } from "../../src/whatsapp/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
/** Tuesday 20/10, 14:00 in São Paulo. */
const VISIT = new Date("2026-10-20T17:00:00Z");
/** Wednesday 21/10, 11:00 in São Paulo. */
const NEXT_DAY = new Date("2026-10-21T14:00:00Z");
const PHONES = { maria: "5511900000081", joao: "5511900000082" };

describe.skipIf(!url)("PrismaSurveyRepository (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "s".repeat(32));
  let db: PrismaClient;
  let repo: PrismaSurveyRepository;
  let service: SurveyService;
  let channel: SandboxChannel;
  let clinicId = "";
  let otherClinicId = "";
  const ids: Record<string, string> = {};
  const candidate = (appointmentId: string, patientId: string): SurveyCandidate => ({
    appointmentId,
    clinicId,
    clinicName: "Clínica Pesquisa",
    clinicTimeZone: "America/Sao_Paulo",
    patientId,
    patientName: "",
    phone: "",
    startsAt: VISIT,
  });

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    repo = new PrismaSurveyRepository(db, cipher);
    clinicId = (await db.clinic.create({ data: { name: "Clínica Pesquisa" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Clínica" } })).id;
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Pesquisa" } })).id;
    const procedureId = (
      await db.procedure.create({ data: { clinicId, name: "Avaliação", durationMinutes: 30 } })
    ).id;
    const agenda = (await prismaAgendaFor(db, cipher, clinicId))!;
    ids.maria = (
      await agenda.cadastrarPaciente({ name: "Maria Pesquisa", phone: PHONES.maria })
    ).id;
    ids.joao = (await agenda.cadastrarPaciente({ name: "João Pesquisa", phone: PHONES.joao })).id;
    const appt = (patientId: string, status: "COMPLETED" | "NO_SHOW") =>
      db.appointment.create({
        data: {
          clinicId,
          patientId,
          dentistId,
          procedureId,
          status,
          startsAt: VISIT,
          endsAt: new Date(VISIT.getTime() + 1800_000),
        },
      });
    ids.mariaAppt = (await appt(ids.maria, "COMPLETED")).id;
    await appt(ids.joao, "NO_SHOW");
    channel = new SandboxChannel();
    service = new SurveyService({
      repo,
      channel,
      store: new InMemoryConversationStore({ id: clinicId, name: "Clínica Pesquisa" }),
      logger: silentLogger,
    });
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.satisfactionSurvey.deleteMany({ where: { clinicId: id } });
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("asks attended patients once, scoped by clinic", async () => {
    expect(await repo.candidates(new Date(VISIT.getTime() - 1), NEXT_DAY, otherClinicId)).toEqual(
      [],
    );
    expect(await service.run(NEXT_DAY, clinicId)).toEqual({ sent: 1 });
    expect(channel.outbox).toEqual([
      expect.objectContaining({
        to: PHONES.maria,
        template: "pesquisa_satisfacao",
        params: ["Maria", "Clínica Pesquisa", "20/10"],
      }),
    ]);
    expect(await service.run(new Date(NEXT_DAY.getTime() + 3600_000), clinicId)).toEqual({
      sent: 0,
    });
    const survey = await db.satisfactionSurvey.findUniqueOrThrow({
      where: { appointmentId: ids.mariaAppt },
    });
    ids.survey = survey.id;
    expect(await repo.create(candidate(ids.mariaAppt!, ids.maria!), NEXT_DAY)).toBeNull();
    expect(await repo.askedSince(ids.maria!, VISIT)).toBe(true);
    expect(await repo.askedSince(ids.joao!, VISIT)).toBe(false);
  });

  it("records the rating once and summarizes it for the clinic only", async () => {
    expect(await repo.get(otherClinicId, ids.survey!)).toBeNull();
    expect(await service.answer(clinicId, PHONES.joao, ids.survey!, 1, NEXT_DAY)).toEqual({
      text: SURVEY_MESSAGES.notFound,
    });
    const low = await service.answer(clinicId, PHONES.maria, ids.survey!, 1, NEXT_DAY);
    expect(low.handoff).toBe("survey:low");
    expect(await repo.answer(ids.survey!, 5, NEXT_DAY)).toBe(false);

    const summary = await service.summary(clinicId, new Date("2026-10-22T12:00:00Z"));
    expect(summary.month).toEqual({ sent: 1, answers: 1, average: 1, byRating: [1, 0, 0, 0, 0] });
    expect(summary.low).toEqual([
      expect.objectContaining({
        surveyId: ids.survey,
        patientName: "Maria Pesquisa",
        patientPhone: "***0081",
        rating: 1,
        appointmentAt: VISIT.toISOString(),
      }),
    ]);
    expect((await service.summary(otherClinicId, NEXT_DAY)).month.sent).toBe(0);
  });

  it("removes an unanswered survey so a failed send is retried", async () => {
    const joaoAppt = await db.appointment.findFirstOrThrow({
      where: { clinicId, patientId: ids.joao },
    });
    const id = await repo.create(candidate(joaoAppt.id, ids.joao!), NEXT_DAY);
    expect(id).toEqual(expect.any(String));
    await repo.remove(id!);
    await repo.remove(ids.survey!); // answered: kept
    expect(await db.satisfactionSurvey.count({ where: { clinicId } })).toBe(1);
  });
});
