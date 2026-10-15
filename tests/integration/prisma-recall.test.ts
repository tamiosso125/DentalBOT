import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryConversationStore } from "../../src/conversation/store.js";
import { silentLogger } from "../../src/lib/logger.js";
import { FieldCipher } from "../../src/privacy/index.js";
import { PrismaRecallRepository } from "../../src/recall/prisma-recall.js";
import { RecallService } from "../../src/recall/recall.js";
import { SandboxChannel } from "../../src/whatsapp/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
// Tuesday 2026-10-20, 10:00 in São Paulo.
const NOW = new Date("2026-10-20T13:00:00Z");
const CUTOFF = new Date("2026-04-20T03:00:00Z");
const PHONES = { ana: "5511900000061", bia: "5511900000062", caio: "5511900000063" };

describe.skipIf(!url)("PrismaRecallRepository (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "r".repeat(32));
  let db: PrismaClient;
  let repo: PrismaRecallRepository;
  let clinicId = "";
  let otherClinicId = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    repo = new PrismaRecallRepository(db, cipher);
    clinicId = (await db.clinic.create({ data: { name: "Clínica Retorno" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Clínica" } })).id;
    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Volta" } })).id;
    const procedureId = (
      await db.procedure.create({ data: { clinicId, name: "Limpeza", durationMinutes: 45 } })
    ).id;
    const patient = async (name: string, phone: string) =>
      (
        await db.patient.create({
          data: {
            clinicId,
            name,
            phoneHash: cipher.hash(phone),
            phoneEncrypted: cipher.encrypt(phone),
          },
        })
      ).id;
    const visit = (patientId: string, startsAt: string, status = "COMPLETED" as const) =>
      db.appointment.create({
        data: {
          clinicId,
          patientId,
          dentistId,
          procedureId,
          startsAt: new Date(startsAt),
          endsAt: new Date(new Date(startsAt).getTime() + 45 * 60_000),
          status,
        },
      });
    // Ana: cleaning in March, consent given. Bia: March too, but a cancelled visit in
    // September does not count, and she said PARAR after consenting. Caio: came back in
    // August (not due).
    ids.ana = await patient("Ana Exemplo", PHONES.ana);
    ids.bia = await patient("Bia Exemplo", PHONES.bia);
    ids.caio = await patient("Caio Exemplo", PHONES.caio);
    await visit(ids.ana, "2026-03-10T13:00:00Z");
    await visit(ids.bia, "2026-03-12T13:00:00Z");
    await db.appointment.create({
      data: {
        clinicId,
        patientId: ids.bia,
        dentistId,
        procedureId,
        startsAt: new Date("2026-09-01T13:00:00Z"),
        endsAt: new Date("2026-09-01T13:45:00Z"),
        status: "CANCELLED",
      },
    });
    await visit(ids.caio, "2026-02-10T13:00:00Z");
    await visit(ids.caio, "2026-08-10T13:00:00Z");
    for (const id of [ids.ana, ids.bia, ids.caio])
      await repo.recordConsent(clinicId, id, true, new Date("2026-09-01T12:00:00Z"));
    await db.conversation.create({
      data: {
        clinicId,
        patientId: ids.bia,
        contactHash: cipher.hash(PHONES.bia),
        contactEncrypted: cipher.encrypt(PHONES.bia),
        marketingOptOutAt: new Date("2026-09-10T12:00:00Z"),
      },
    });
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.conversation.deleteMany({ where: { clinicId: id } });
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.consent.deleteMany({ where: { patient: { clinicId: id } } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("finds patients whose last real visit is before the cutoff, with consent and opt-out", async () => {
    const rows = await repo.rows(clinicId, CUTOFF, NOW);
    expect(rows.map((r) => r.patientName)).toEqual(["Ana Exemplo", "Bia Exemplo"]);
    expect(rows[0]).toMatchObject({
      phone: PHONES.ana,
      lastProcedure: "Limpeza",
      lastVisitAt: new Date("2026-03-10T13:00:00Z"),
      consent: { granted: true },
      optedOutAt: null,
      invitedAt: null,
    });
    expect(rows[1]!.optedOutAt).toEqual(new Date("2026-09-10T12:00:00Z"));
    expect(await repo.rows(otherClinicId, CUTOFF, NOW)).toEqual([]);
  });

  it("sends one invitation per last visit, only to who may receive it", async () => {
    const channel = new SandboxChannel();
    const recall = new RecallService({
      repo,
      channel,
      store: new InMemoryConversationStore({ id: clinicId, name: "Clínica Retorno" }),
      logger: silentLogger,
    });
    expect(await recall.run(NOW)).toEqual({ sent: 1 });
    expect(channel.outbox).toMatchObject([{ to: PHONES.ana, template: "convite_retorno" }]);
    expect(await recall.run(NOW)).toEqual({ sent: 0 });
    const list = await recall.list(clinicId, NOW);
    expect(list.rows.map((r) => [r.patientPhone, r.status])).toEqual([
      ["***0061", "invited"],
      ["***0062", "opted_out"],
    ]);
  });

  it("leaves out anyone with something booked or anonymized, and scopes consent by clinic", async () => {
    expect(await repo.recordConsent(otherClinicId, ids.ana!, true, NOW)).toBe(false);
    await db.patient.update({ where: { id: ids.bia! }, data: { anonymizedAt: NOW } });
    expect(await repo.recordConsent(clinicId, ids.bia!, true, NOW)).toBe(false);
    const dentist = await db.dentist.findFirstOrThrow({ where: { clinicId } });
    const procedure = await db.procedure.findFirstOrThrow({ where: { clinicId } });
    await db.appointment.create({
      data: {
        clinicId,
        patientId: ids.ana!,
        dentistId: dentist.id,
        procedureId: procedure.id,
        startsAt: new Date("2026-11-03T13:00:00Z"),
        endsAt: new Date("2026-11-03T13:45:00Z"),
      },
    });
    expect(await repo.rows(clinicId, CUTOFF, NOW)).toEqual([]);
    expect(await repo.recordConsent(clinicId, ids.ana!, false, NOW)).toBe(true);
    const consents = await db.consent.findMany({
      where: { patientId: ids.ana!, purpose: "MARKETING" },
      orderBy: { createdAt: "asc" },
    });
    expect(consents.map((c) => [c.granted, c.textVersion])).toEqual([
      [true, "retorno-v1"],
      [false, "retorno-v1"],
    ]);
  });
});
