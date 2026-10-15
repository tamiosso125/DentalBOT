import { Prisma, type PrismaClient } from "@prisma/client";
import type { FieldCipher } from "../privacy/index.js";
import type {
  ListedEntry,
  WaitlistAnswer,
  WaitlistRepository,
  WaitlistStatus,
} from "./waitlist.js";

const entrySelect = {
  id: true,
  patientId: true,
  procedureId: true,
  until: true,
  status: true,
  createdAt: true,
  closedAt: true,
  patient: { select: { name: true, phoneEncrypted: true } },
  procedure: { select: { name: true } },
  offers: {
    orderBy: { sentAt: "desc" },
    select: { sentAt: true, startsAt: true, answer: true },
  },
} satisfies Prisma.WaitlistEntrySelect;

export class PrismaWaitlistRepository implements WaitlistRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async clinicsWaiting() {
    const rows = await this.db.clinic.findMany({
      where: { waitlist: { some: { status: "WAITING" } } },
      select: { id: true, name: true, timezone: true },
    });
    return rows.map((c) => ({ id: c.id, name: c.name, timeZone: c.timezone }));
  }

  async clinic(clinicId: string) {
    const c = await this.db.clinic.findUnique({
      where: { id: clinicId },
      select: { id: true, name: true, timezone: true },
    });
    return c ? { id: c.id, name: c.name, timeZone: c.timezone } : null;
  }

  async expire(clinicId: string, now: Date) {
    const { count } = await this.db.waitlistEntry.updateMany({
      where: { clinicId, status: "WAITING", until: { lte: now } },
      data: { status: "EXPIRED", closedAt: now },
    });
    return count;
  }

  async waiting(clinicId: string) {
    return this.rows({ clinicId, status: "WAITING" });
  }

  async list(clinicId: string, closedSince: Date) {
    return this.rows({
      clinicId,
      OR: [{ status: "WAITING" }, { closedAt: { gte: closedSince } }],
    });
  }

  private async rows(where: Prisma.WaitlistEntryWhereInput): Promise<ListedEntry[]> {
    const rows = await this.db.waitlistEntry.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: 500,
      select: entrySelect,
    });
    return rows.map((e) => {
      const last = e.offers[0];
      return {
        id: e.id,
        patientId: e.patientId,
        patientName: e.patient.name,
        phone: this.cipher.decrypt(e.patient.phoneEncrypted),
        procedureId: e.procedureId,
        procedureName: e.procedure.name,
        until: e.until,
        createdAt: e.createdAt,
        lastOfferAt: last?.sentAt ?? null,
        status: e.status,
        closedAt: e.closedAt,
        offers: e.offers.length,
        lastOffer: last ? { startsAt: last.startsAt, answer: last.answer } : null,
      };
    });
  }

  async slotOfferedSince(dentistId: string, startsAt: Date, since: Date) {
    const n = await this.db.waitlistOffer.count({
      where: { dentistId, startsAt, sentAt: { gte: since } },
    });
    return n > 0;
  }

  async createOffer(
    entryId: string,
    slot: { dentistId: string; startsAt: Date; endsAt: Date },
    at: Date,
  ) {
    try {
      const o = await this.db.waitlistOffer.create({
        data: {
          entryId,
          dentistId: slot.dentistId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          sentAt: at,
        },
        select: { id: true },
      });
      return o.id;
    } catch (err) {
      // Unique (entry, dentist, start): this patient already got this slot.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
      throw err;
    }
  }

  async deleteOffer(offerId: string) {
    await this.db.waitlistOffer.deleteMany({ where: { id: offerId } });
  }

  async offer(clinicId: string, offerId: string) {
    const o = await this.db.waitlistOffer.findFirst({
      where: { id: offerId, entry: { clinicId } },
      select: {
        id: true,
        dentistId: true,
        startsAt: true,
        endsAt: true,
        answer: true,
        entry: {
          select: {
            id: true,
            status: true,
            patientId: true,
            procedureId: true,
            patient: { select: { phoneEncrypted: true } },
            procedure: { select: { name: true } },
          },
        },
      },
    });
    if (!o) return null;
    return {
      id: o.id,
      entryId: o.entry.id,
      entryStatus: o.entry.status,
      patientId: o.entry.patientId,
      phone: this.cipher.decrypt(o.entry.patient.phoneEncrypted),
      procedureId: o.entry.procedureId,
      procedureName: o.entry.procedure.name,
      dentistId: o.dentistId,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      answer: o.answer,
    };
  }

  async setAnswer(offerId: string, answer: WaitlistAnswer, at: Date) {
    await this.db.waitlistOffer.updateMany({
      where: { id: offerId },
      data: { answer, answeredAt: at },
    });
  }

  async close(
    clinicId: string,
    entryId: string,
    status: Exclude<WaitlistStatus, "WAITING">,
    at: Date,
  ) {
    const { count } = await this.db.waitlistEntry.updateMany({
      where: { id: entryId, clinicId, status: "WAITING" },
      data: { status, closedAt: at },
    });
    return count === 1;
  }

  async settle(entryId: string, status: WaitlistStatus, at: Date, appointmentId?: string) {
    await this.db.waitlistEntry.updateMany({
      where: { id: entryId },
      data: {
        status,
        closedAt: status === "WAITING" ? null : at,
        ...(appointmentId ? { appointmentId } : {}),
      },
    });
  }

  async add(clinicId: string, patientId: string, procedureId: string, until: Date) {
    const [patient, procedure] = await Promise.all([
      this.db.patient.findFirst({
        where: { id: patientId, clinicId, anonymizedAt: null },
        select: { id: true },
      }),
      this.db.procedure.findFirst({ where: { id: procedureId, clinicId }, select: { id: true } }),
    ]);
    if (!patient || !procedure) return null;
    const existing = await this.db.waitlistEntry.findFirst({
      where: { clinicId, patientId, procedureId, status: "WAITING" },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };
    const e = await this.db.waitlistEntry.create({
      data: { clinicId, patientId, procedureId, until },
      select: { id: true },
    });
    return { id: e.id, created: true };
  }
}
