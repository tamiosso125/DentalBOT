import type { InstallmentStatus, PrismaClient } from "@prisma/client";
import type { Logger } from "../lib/logger.js";
import { dateInZone } from "../scheduling/time.js";

/**
 * "Pendências": the patients the front desk should contact or fix today, in one list. Each
 * row is one patient with what is pending (overdue installments, visits this week still
 * unconfirmed, past visits nobody marked attended or missed). Names only: no phone, CPF
 * or health data. Same rules as the "Pendências" box on the patient record.
 */

export type PendingKind = "OVERDUE" | "UNCONFIRMED" | "UNMARKED";

export type PendingRow = {
  patientId: string;
  patientName: string;
  items: Array<{
    kind: PendingKind;
    /** Overdue: the amount (cents) and how many installments. Visits: when, ISO instant. */
    amountCents?: number;
    count?: number;
    appointmentId?: string;
    at?: string;
  }>;
};

const OPEN: InstallmentStatus[] = ["PENDING", "BILLED", "OVERDUE"];
const DAY_MS = 86_400_000;
const WEEK_AHEAD_MS = 7 * DAY_MS;
/** Past visits older than this are left to the attendance list on the agenda. */
const UNMARKED_DAYS = 30;
const CAP = 300;

export class PendingList {
  constructor(private readonly deps: { db: PrismaClient; logger: Logger }) {}

  async list(clinicId: string, now: Date): Promise<PendingRow[]> {
    const clinic = await this.deps.db.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    if (!clinic) return [];
    const today = new Date(`${dateInZone(now, clinic.timezone)}T00:00:00Z`);
    const patient = { select: { id: true, name: true, anonymizedAt: true } };

    const [installments, unconfirmed, unmarked] = await Promise.all([
      this.deps.db.installment.findMany({
        where: {
          quote: { clinicId, patient: { anonymizedAt: null } },
          OR: [{ status: "OVERDUE" }, { status: { in: OPEN }, dueDate: { lt: today } }],
        },
        select: { amountCents: true, quote: { select: { patient } } },
        take: CAP * 5,
      }),
      this.deps.db.appointment.findMany({
        where: {
          clinicId,
          status: "PENDING_CONFIRMATION",
          startsAt: { gte: now, lte: new Date(now.getTime() + WEEK_AHEAD_MS) },
          patient: { anonymizedAt: null },
        },
        orderBy: { startsAt: "asc" },
        select: { id: true, startsAt: true, patient },
        take: CAP,
      }),
      this.deps.db.appointment.findMany({
        where: {
          clinicId,
          status: { in: ["PENDING_CONFIRMATION", "CONFIRMED"] },
          startsAt: { gte: new Date(now.getTime() - UNMARKED_DAYS * DAY_MS), lt: now },
          patient: { anonymizedAt: null },
        },
        orderBy: { startsAt: "asc" },
        select: { id: true, startsAt: true, patient },
        take: CAP,
      }),
    ]);

    const rows = new Map<string, PendingRow>();
    const rowOf = (p: { id: string; name: string }) => {
      let row = rows.get(p.id);
      if (!row) rows.set(p.id, (row = { patientId: p.id, patientName: p.name, items: [] }));
      return row;
    };

    const overdue = new Map<string, { amountCents: number; count: number }>();
    for (const i of installments) {
      const p = i.quote.patient;
      const sum = overdue.get(p.id) ?? { amountCents: 0, count: 0 };
      overdue.set(p.id, { amountCents: sum.amountCents + i.amountCents, count: sum.count + 1 });
      rowOf(p);
    }
    for (const [id, sum] of overdue) rows.get(id)!.items.push({ kind: "OVERDUE", ...sum });
    for (const a of unconfirmed)
      rowOf(a.patient).items.push({
        kind: "UNCONFIRMED",
        appointmentId: a.id,
        at: a.startsAt.toISOString(),
      });
    for (const a of unmarked)
      rowOf(a.patient).items.push({
        kind: "UNMARKED",
        appointmentId: a.id,
        at: a.startsAt.toISOString(),
      });

    const out = [...rows.values()].sort(
      (a, b) =>
        b.items.length - a.items.length || a.patientName.localeCompare(b.patientName, "pt-BR"),
    );
    this.deps.logger.info({ clinicId, patients: out.length }, "pending list built");
    return out;
  }
}
