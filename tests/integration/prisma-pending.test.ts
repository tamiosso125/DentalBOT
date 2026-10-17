import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger.js";
import { PendingList } from "../../src/panel/pending.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;
const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-17T15:00:00Z");

describe.skipIf(!url)("PendingList (Postgres)", () => {
  let db: PrismaClient;
  let pending: PendingList;
  let clinicId = "";
  let otherClinicId = "";
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    pending = new PendingList({ db, logger: createLogger("silent") });
    clinicId = (await db.clinic.create({ data: { name: "Clínica Pendências" } })).id;
    otherClinicId = (await db.clinic.create({ data: { name: "Outra Pendências" } })).id;
    const patient = async (clinic: string, name: string, n: number, anonymizedAt?: Date) =>
      (
        await db.patient.create({
          data: { clinicId: clinic, name, phoneHash: `hp${n}`, phoneEncrypted: "x", anonymizedAt },
        })
      ).id;
    const maria = await patient(clinicId, "Maria Devedora", 1);
    const bruno = await patient(clinicId, "Bruno Sem Confirmar", 2);
    const carla = await patient(clinicId, "Carla Tudo Certo", 3);
    const anon = await patient(clinicId, "Anônimo", 4, at("2026-10-01"));
    const outra = await patient(otherClinicId, "Paciente de Outra Clínica", 5);
    ids = { maria, bruno, carla, anon, outra };

    const dentistId = (await db.dentist.create({ data: { clinicId, name: "Dra. Ana" } })).id;
    const procedureId = (
      await db.procedure.create({ data: { clinicId, name: "Limpeza", durationMinutes: 30 } })
    ).id;
    const otherDentist = (
      await db.dentist.create({ data: { clinicId: otherClinicId, name: "Dr. B" } })
    ).id;
    const otherProcedure = (
      await db.procedure.create({
        data: { clinicId: otherClinicId, name: "Limpeza", durationMinutes: 30 },
      })
    ).id;
    const appt = (
      patientId: string,
      status: "PENDING_CONFIRMATION" | "CONFIRMED" | "COMPLETED" | "CANCELLED",
      startsAt: string,
      clinic = clinicId,
    ) =>
      db.appointment.create({
        data: {
          clinicId: clinic,
          patientId,
          dentistId: clinic === clinicId ? dentistId : otherDentist,
          procedureId: clinic === clinicId ? procedureId : otherProcedure,
          startsAt: at(startsAt),
          endsAt: at(startsAt.replace(":00:00", ":30:00")),
          status,
        },
      });
    // Bruno: unconfirmed in 3 days (pending), another in 20 days (too far), one cancelled soon.
    await appt(bruno, "PENDING_CONFIRMATION", "2026-10-20T13:00:00Z");
    await appt(bruno, "PENDING_CONFIRMATION", "2026-11-06T13:00:00Z");
    await appt(bruno, "CANCELLED", "2026-10-19T13:00:00Z");
    // Maria: a past visit nobody marked.
    await appt(maria, "CONFIRMED", "2026-10-15T13:00:00Z");
    // Carla: completed past visit and a confirmed future one: nothing pending.
    await appt(carla, "COMPLETED", "2026-10-15T13:00:00Z");
    await appt(carla, "CONFIRMED", "2026-10-20T13:00:00Z");
    // Anonymized and other-clinic patients never show up.
    await appt(anon, "PENDING_CONFIRMATION", "2026-10-20T13:00:00Z");
    await appt(outra, "PENDING_CONFIRMATION", "2026-10-20T13:00:00Z", otherClinicId);

    const quote = async (clinic: string, patientId: string, dentist: string) =>
      (
        await db.quote.create({
          data: {
            clinicId: clinic,
            patientId,
            dentistId: dentist,
            totalCents: 90000,
            installmentCount: 3,
          },
        })
      ).id;
    const installment = (
      quoteId: string,
      number: number,
      status: "PENDING" | "OVERDUE" | "PAID",
      dueDate: string,
    ) =>
      db.installment.create({
        data: { quoteId, number, amountCents: 30000, status, dueDate: at(`${dueDate}T00:00:00Z`) },
      });
    const q = await quote(clinicId, maria, dentistId);
    await installment(q, 1, "PAID", "2026-09-10");
    await installment(q, 2, "PENDING", "2026-10-10"); // open and past due
    await installment(q, 3, "OVERDUE", "2026-10-16"); // flagged by Asaas
    await installment(q, 4, "PENDING", "2026-10-17"); // due today: not late yet
    await installment(q, 5, "PENDING", "2026-11-17");
    const qa = await quote(clinicId, anon, dentistId);
    await installment(qa, 1, "OVERDUE", "2026-10-01");
    const qo = await quote(otherClinicId, outra, otherDentist);
    await installment(qo, 1, "OVERDUE", "2026-10-01");
  });

  afterAll(async () => {
    for (const id of [clinicId, otherClinicId]) {
      await db.installment.deleteMany({ where: { quote: { clinicId: id } } });
      await db.quote.deleteMany({ where: { clinicId: id } });
      await db.appointment.deleteMany({ where: { clinicId: id } });
      await db.patient.deleteMany({ where: { clinicId: id } });
      await db.procedure.deleteMany({ where: { clinicId: id } });
      await db.dentist.deleteMany({ where: { clinicId: id } });
      await db.clinic.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("lists each patient once with what is pending, most items first", async () => {
    const rows = await pending.list(clinicId, NOW);
    expect(rows.map((r) => r.patientName)).toEqual(["Maria Devedora", "Bruno Sem Confirmar"]);

    const maria = rows[0]!;
    expect(maria.patientId).toBe(ids.maria);
    expect(maria.items).toEqual([
      { kind: "OVERDUE", amountCents: 60000, count: 2 },
      expect.objectContaining({ kind: "UNMARKED", at: "2026-10-15T13:00:00.000Z" }),
    ]);

    const bruno = rows[1]!;
    expect(bruno.items).toEqual([
      expect.objectContaining({ kind: "UNCONFIRMED", at: "2026-10-20T13:00:00.000Z" }),
    ]);
  });

  it("leaves out anonymized patients, other clinics and patients with nothing pending", async () => {
    const rows = await pending.list(clinicId, NOW);
    const names = rows.map((r) => r.patientName);
    expect(names).not.toContain("Anônimo");
    expect(names).not.toContain("Carla Tudo Certo");
    expect(names).not.toContain("Paciente de Outra Clínica");
    expect(await pending.list("clinica-inexistente", NOW)).toEqual([]);
  });

  it("does not carry phone, CPF or any other personal field", async () => {
    const [row] = await pending.list(clinicId, NOW);
    expect(Object.keys(row!).sort()).toEqual(["items", "patientId", "patientName"]);
  });
});
