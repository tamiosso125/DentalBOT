import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryConversationStore } from "../../src/conversation/store.js";
import { silentLogger } from "../../src/lib/logger.js";
import { FieldCipher } from "../../src/privacy/index.js";
import {
  NoShowFollowUps,
  PrismaNoShowFollowUpRepository,
} from "../../src/scheduling/no-show-follow-up.js";
import { prismaAgendaFor } from "../../src/scheduling/prisma-agenda.js";
import { SandboxChannel } from "../../src/whatsapp/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
/** Tuesday 20/10, 14:00 in São Paulo. */
const VISIT = new Date("2026-10-20T17:00:00Z");
/** Wednesday 21/10, 10:00 in São Paulo. */
const NEXT_DAY = new Date("2026-10-21T13:00:00Z");
const PHONES = { maria: "5511900000083", joao: "5511900000084", ana: "5511900000085" };

describe.skipIf(!url)("PrismaNoShowFollowUpRepository (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "n".repeat(32));
  let db: PrismaClient;
  let repo: PrismaNoShowFollowUpRepository;
  let channel: SandboxChannel;
  let service: NoShowFollowUps;
  let clinicId = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    repo = new PrismaNoShowFollowUpRepository(db, cipher);
    clinicId = (await db.clinic.create({ data: { name: "Clínica Falta" } })).id;
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Falta" } })).id;
    const procedureId = (
      await db.procedure.create({ data: { clinicId, name: "Avaliação", durationMinutes: 30 } })
    ).id;
    const agenda = (await prismaAgendaFor(db, cipher, clinicId))!;
    const appt = async (
      phone: string,
      name: string,
      status: "NO_SHOW" | "COMPLETED" | "CONFIRMED",
      startsAt = VISIT,
    ) => {
      const patient =
        (await agenda.buscarPaciente({ phone })) ??
        (await agenda.cadastrarPaciente({ name, phone }));
      return (
        await db.appointment.create({
          data: {
            clinicId,
            patientId: patient.id,
            dentistId,
            procedureId,
            status,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 1800_000),
          },
        })
      ).id;
    };
    ids.maria = await appt(PHONES.maria, "Maria Falta", "NO_SHOW");
    await appt(PHONES.joao, "João Veio", "COMPLETED");
    // Ana missed it but already booked again for next week.
    await appt(PHONES.ana, "Ana Remarcou", "NO_SHOW");
    await appt(PHONES.ana, "Ana Remarcou", "CONFIRMED", new Date("2026-10-27T13:00:00Z"));
    channel = new SandboxChannel();
    service = new NoShowFollowUps({
      repo,
      channel,
      store: new InMemoryConversationStore({ id: clinicId, name: "Clínica Falta" }),
      logger: silentLogger,
    });
  });

  afterAll(async () => {
    await db.appointment.deleteMany({ where: { clinicId } });
    await db.patient.deleteMany({ where: { clinicId } });
    await db.procedure.deleteMany({ where: { clinicId } });
    await db.dentist.deleteMany({ where: { clinicId } });
    await db.clinic.delete({ where: { id: clinicId } });
    await db.$disconnect();
  });

  it("lists only no-shows of patients who did not book again", async () => {
    const rows = await repo.noShowCandidates(new Date(VISIT.getTime() - 1), NEXT_DAY, clinicId);
    expect(rows).toEqual([
      expect.objectContaining({
        appointmentId: ids.maria,
        patientName: "Maria Falta",
        phone: PHONES.maria,
        clinicName: "Clínica Falta",
      }),
    ]);
  });

  it("sends once, claiming the appointment, and releases it on failure", async () => {
    expect(await repo.claimNoShowNotice(ids.maria!, NEXT_DAY)).toBe(true);
    expect(await repo.claimNoShowNotice(ids.maria!, NEXT_DAY)).toBe(false);
    await repo.releaseNoShowNotice(ids.maria!);

    expect(await service.run(NEXT_DAY, clinicId)).toEqual({ sent: 1 });
    expect(channel.outbox).toEqual([
      expect.objectContaining({
        to: PHONES.maria,
        template: "consulta_perdida",
        buttonPayloads: [`appt:${ids.maria}:rebook`, "handoff"],
      }),
    ]);
    expect(await service.run(new Date(NEXT_DAY.getTime() + 3600_000), clinicId)).toEqual({
      sent: 0,
    });
    const row = await db.appointment.findUniqueOrThrow({ where: { id: ids.maria } });
    expect(row.noShowNoticeAt).toEqual(NEXT_DAY);
  });
});
