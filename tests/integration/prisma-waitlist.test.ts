import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryConversationStore } from "../../src/conversation/store.js";
import { silentLogger } from "../../src/lib/logger.js";
import { FieldCipher } from "../../src/privacy/index.js";
import type { AgendaService } from "../../src/scheduling/agenda-service.js";
import { prismaAgendaFor } from "../../src/scheduling/prisma-agenda.js";
import { PrismaWaitlistRepository } from "../../src/waitlist/prisma-waitlist.js";
import { WaitlistService } from "../../src/waitlist/waitlist.js";
import { SandboxChannel } from "../../src/whatsapp/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
// Monday 2026-10-19, 09:00 in São Paulo.
const NOW = new Date("2026-10-19T12:00:00Z");
/** Tuesday 20/10, 10:00: the only gap of the week, held by João. */
const GAP = new Date("2026-10-20T13:00:00Z");
const PHONES = { maria: "5511900000071", joao: "5511900000072" };

describe.skipIf(!url)("PrismaWaitlistRepository (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "w".repeat(32));
  let db: PrismaClient;
  let repo: PrismaWaitlistRepository;
  let agenda: AgendaService;
  let service: WaitlistService;
  let channel: SandboxChannel;
  let clinicId = "";
  let otherClinicId = "";
  let procedureId = "";
  let dentistId = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    repo = new PrismaWaitlistRepository(db, cipher);
    clinicId = (await db.clinic.create({ data: { name: "Clínica Espera" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Clínica" } })).id;
    dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Espera" } })).id;
    // Open only on Tuesday morning, and all of it blocked but 10:00-10:30.
    await db.workingHours.create({
      data: { dentistId, weekday: 2, startMinute: 8 * 60, endMinute: 12 * 60 },
    });
    await db.scheduleBlock.createMany({
      data: [
        { dentistId, startsAt: new Date("2026-10-20T11:00:00Z"), endsAt: GAP },
        {
          dentistId,
          startsAt: new Date("2026-10-20T13:30:00Z"),
          endsAt: new Date("2026-10-20T15:00:00Z"),
        },
      ],
    });
    procedureId = (
      await db.procedure.create({ data: { clinicId, name: "Avaliação", durationMinutes: 30 } })
    ).id;
    agenda = (await prismaAgendaFor(db, cipher, clinicId, { now: () => NOW }))!;
    ids.maria = (await agenda.cadastrarPaciente({ name: "Maria Espera", phone: PHONES.maria })).id;
    ids.joao = (await agenda.cadastrarPaciente({ name: "João Espera", phone: PHONES.joao })).id;
    ids.joaoAppt = (
      await agenda.reservar({
        patientId: ids.joao,
        slot: { dentistId, procedureId, startsAt: GAP, endsAt: new Date(GAP.getTime() + 1800_000) },
      })
    ).appointmentId;
    channel = new SandboxChannel();
    service = new WaitlistService({
      repo,
      agendaFor: async (id) => (id === clinicId ? agenda : null),
      channel,
      store: new InMemoryConversationStore({ id: clinicId, name: "Clínica Espera" }),
      logger: silentLogger,
    });
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.waitlistEntry.deleteMany({ where: { clinicId: id } });
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.scheduleBlock.deleteMany({ where: { dentist: { clinicId: id } } });
      await db.workingHours.deleteMany({ where: { dentist: { clinicId: id } } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("keeps one waiting entry per patient and procedure, scoped by clinic", async () => {
    const until = new Date("2026-10-23T03:00:00Z");
    const first = await repo.add(clinicId, ids.maria!, procedureId, until);
    expect(first).toEqual({ id: expect.any(String), created: true });
    expect(await repo.add(clinicId, ids.maria!, procedureId, until)).toEqual({
      id: first!.id,
      created: false,
    });
    expect(await repo.add(otherClinicId, ids.maria!, procedureId, until)).toBeNull();
    expect(await repo.waiting(clinicId)).toEqual([
      expect.objectContaining({
        patientName: "Maria Espera",
        phone: PHONES.maria,
        procedureName: "Avaliação",
        until,
        lastOfferAt: null,
      }),
    ]);
    expect(await repo.waiting(otherClinicId)).toEqual([]);
    expect((await repo.clinicsWaiting()).map((c) => c.id)).toContain(clinicId);
    ids.entry = first!.id;
  });

  it("offers the freed slot once and books it on accept", async () => {
    expect(await service.run(NOW)).toEqual({ sent: 0 });
    await agenda.cancelar({ appointmentId: ids.joaoAppt!, patientId: ids.joao! });
    expect(await service.run(NOW)).toEqual({ sent: 1 });
    expect(channel.outbox).toMatchObject([{ to: PHONES.maria, template: "vaga_disponivel" }]);
    expect(await service.run(NOW)).toEqual({ sent: 0 });

    const offer = await db.waitlistOffer.findFirstOrThrow({ where: { entryId: ids.entry! } });
    expect(await repo.slotOfferedSince(dentistId, GAP, NOW)).toBe(true);
    expect(await repo.createOffer(ids.entry!, offer, NOW)).toBeNull();
    expect(await repo.offer(otherClinicId, offer.id)).toBeNull();

    const out = await service.answer(clinicId, PHONES.maria, offer.id, true, NOW);
    expect(out.text).toContain("Pronto!");
    const booked = await db.appointment.findFirstOrThrow({
      where: { patientId: ids.maria!, status: { not: "CANCELLED" } },
    });
    expect(booked.startsAt).toEqual(GAP);
    expect(await db.waitlistEntry.findUniqueOrThrow({ where: { id: ids.entry! } })).toMatchObject({
      status: "BOOKED",
      appointmentId: booked.id,
      closedAt: NOW,
    });
    expect((await db.waitlistOffer.findUniqueOrThrow({ where: { id: offer.id } })).answer).toBe(
      "ACCEPTED",
    );
    const listed = await repo.list(clinicId, new Date(NOW.getTime() - 86_400_000));
    expect(listed).toEqual([
      expect.objectContaining({
        status: "BOOKED",
        offers: 1,
        lastOffer: { startsAt: GAP, answer: "ACCEPTED" },
      }),
    ]);
  });

  it("expires entries past their date and closes only waiting ones", async () => {
    const e = await repo.add(clinicId, ids.joao!, procedureId, new Date("2026-10-20T03:00:00Z"));
    expect(await repo.close(otherClinicId, e!.id, "REMOVED", NOW)).toBe(false);
    expect(await repo.expire(clinicId, new Date("2026-10-20T12:00:00Z"))).toBe(1);
    expect(await repo.close(clinicId, e!.id, "REMOVED", NOW)).toBe(false);
    expect(await repo.waiting(clinicId)).toEqual([]);
  });
});
