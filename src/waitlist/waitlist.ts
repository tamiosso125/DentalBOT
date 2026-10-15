import { z } from "zod";
import type { ConversationStore } from "../conversation/store.js";
import type { Logger } from "../lib/logger.js";
import { maskPhone } from "../privacy/index.js";
import {
  SlotUnavailableError,
  type AgendaProvider,
  type Slot,
} from "../scheduling/agenda-provider.js";
import {
  addDays,
  dateInZone,
  formatDayPtBr,
  formatWhenPtBr,
  minuteOfDayInZone,
  zonedToUtc,
} from "../scheduling/time.js";
import { previewText, type OutboundMessage, type WhatsAppChannel } from "../whatsapp/index.js";

/**
 * Waiting list ("lista de espera"): a patient who wants an earlier slot of a procedure waits
 * for one to open before `until`. A periodic run offers each free slot to the first patients
 * in line by the `vaga_disponivel` template; the first to tap "Quero esse horário" takes it.
 */

export type WaitlistStatus = "WAITING" | "BOOKED" | "REMOVED" | "EXPIRED";
export type WaitlistAnswer = "ACCEPTED" | "DECLINED" | "TAKEN";
export type WaitlistClinic = { id: string; name: string; timeZone: string };

export type WaitingEntry = {
  id: string;
  patientId: string;
  patientName: string;
  /** Decrypted WhatsApp number (wa_id). */
  phone: string;
  procedureId: string;
  procedureName: string;
  until: Date;
  createdAt: Date;
  /** Latest offer sent to this entry. */
  lastOfferAt: Date | null;
};

export type ListedEntry = WaitingEntry & {
  status: WaitlistStatus;
  closedAt: Date | null;
  offers: number;
  lastOffer: { startsAt: Date; answer: WaitlistAnswer | null } | null;
};

export type OfferRecord = {
  id: string;
  entryId: string;
  entryStatus: WaitlistStatus;
  patientId: string;
  phone: string;
  procedureId: string;
  procedureName: string;
  dentistId: string;
  startsAt: Date;
  endsAt: Date;
  answer: WaitlistAnswer | null;
};

export interface WaitlistRepository {
  /** Clinics with someone waiting. */
  clinicsWaiting(): Promise<WaitlistClinic[]>;
  clinic(clinicId: string): Promise<WaitlistClinic | null>;
  /** WAITING entries whose `until` has passed become EXPIRED. */
  expire(clinicId: string, now: Date): Promise<number>;
  /** WAITING entries, first in line first. */
  waiting(clinicId: string): Promise<WaitingEntry[]>;
  /** Entries still waiting plus the ones closed since `closedSince`, for the panel. */
  list(clinicId: string, closedSince: Date): Promise<ListedEntry[]>;
  /** Someone was offered this slot at or after `since`. */
  slotOfferedSince(dentistId: string, startsAt: Date, since: Date): Promise<boolean>;
  /** Records the offer; null if this entry was already offered this slot. */
  createOffer(
    entryId: string,
    slot: { dentistId: string; startsAt: Date; endsAt: Date },
    at: Date,
  ): Promise<string | null>;
  /** Undoes an offer whose message could not be sent. */
  deleteOffer(offerId: string): Promise<void>;
  offer(clinicId: string, offerId: string): Promise<OfferRecord | null>;
  setAnswer(offerId: string, answer: WaitlistAnswer, at: Date): Promise<void>;
  /** WAITING -> `status`. False if the entry is not the clinic's or no longer waiting. */
  close(
    clinicId: string,
    entryId: string,
    status: Exclude<WaitlistStatus, "WAITING">,
    at: Date,
  ): Promise<boolean>;
  /** Sets the entry's outcome after it was closed as the lock (back to WAITING clears it). */
  settle(entryId: string, status: WaitlistStatus, at: Date, appointmentId?: string): Promise<void>;
  /**
   * Puts the clinic's patient on the list for the procedure. If they are already waiting
   * for it, keeps that entry (created: false). Null if the patient (not anonymized) or the
   * procedure is not the clinic's.
   */
  add(
    clinicId: string,
    patientId: string,
    procedureId: string,
    until: Date,
  ): Promise<{ id: string; created: boolean } | null>;
}

export type WaitlistConfig = {
  /** Local hours [from, until) when offers go out. */
  sendFromHour: number;
  sendUntilHour: number;
  /** Patients offered the same slot at once; the first to accept takes it. */
  perSlot: number;
  /** Minutes before a slot nobody took is offered to the next in line, and before the same patient gets another offer. */
  holdMinutes: number;
  /** How far ahead a patient may wait. */
  maxDays: number;
};

export const DEFAULT_WAITLIST_CONFIG: WaitlistConfig = {
  sendFromHour: 8,
  sendUntilHour: 20,
  perSlot: 3,
  holdMinutes: 60,
  maxDays: 60,
};

/** Reply ids of the offer's quick-reply buttons, in the template's button order. */
export const waitlistButtons = (offerId: string) => [`wait:${offerId}:yes`, `wait:${offerId}:no`];

/** Patient-facing answers (pt-BR). Changes here must be reviewed by the clinic. */
export const WAITLIST_MESSAGES = {
  booked: (procedure: string, when: string) =>
    `Pronto! Sua consulta de ${procedure} ficou para ${when}. Você saiu da lista de espera, e a clínica manda lembrete na véspera.`,
  moved: (procedure: string, when: string) =>
    `Pronto! Sua consulta de ${procedure} foi antecipada para ${when}. Você saiu da lista de espera, e a clínica manda lembrete na véspera.`,
  taken:
    "Que pena, essa vaga acabou de ser preenchida. Você continua na lista de espera e a gente avisa se abrir outra.",
  declined: "Tudo bem! Você continua na lista de espera e a gente avisa se abrir outra vaga.",
  alreadyEarlier: (procedure: string) =>
    `Você já tem uma consulta de ${procedure} marcada antes desse horário, então tirei você da lista de espera.`,
  closed: "Essa lista de espera já foi encerrada. Se quiser outro horário, é só pedir por aqui.",
  answered: "Você já respondeu sobre essa vaga. Se precisar de algo, é só chamar por aqui.",
  notFound: "Não encontrei essa vaga. Já chamei a recepção, que te responde em breve.",
} as const;

export const addBodySchema = z.strictObject({
  patientId: z.string().min(1).max(64),
  procedureId: z.string().min(1).max(64),
  /** Last day the patient wants (clinic time), inclusive. */
  until: z.iso.date(),
});

/** A request the front desk can fix. `status` is the HTTP code. */
export class WaitlistError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "WaitlistError";
  }
}

/** What the panel shows: the phone masked, dates as ISO strings. */
export type WaitlistListRow = {
  id: string;
  patientId: string;
  patientName: string;
  patientPhone: string;
  procedureName: string;
  until: string;
  status: WaitlistStatus;
  createdAt: string;
  closedAt: string | null;
  offers: number;
  lastOffer: { startsAt: string; answer: WaitlistAnswer | null } | null;
};

export type WaitlistList = { schedule: string; rows: WaitlistListRow[] };

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const ACTIVE = new Set(["PENDING_CONFIRMATION", "CONFIRMED"]);

/**
 * Safe to run often and from several processes: an offer is recorded before its message
 * (unique per entry and slot) and removed if the send fails; booking goes through the agenda's
 * atomic overlap check, and the entry is closed before booking so two offers cannot both win.
 */
export class WaitlistService {
  private readonly config: WaitlistConfig;

  constructor(
    private readonly deps: {
      repo: WaitlistRepository;
      agendaFor: (clinicId: string) => Promise<AgendaProvider | null>;
      channel: WhatsAppChannel;
      store: ConversationStore;
      logger: Logger;
      config?: Partial<WaitlistConfig>;
    },
  ) {
    this.config = { ...DEFAULT_WAITLIST_CONFIG, ...deps.config };
  }

  async list(clinicId: string, now: Date): Promise<WaitlistList> {
    const { sendFromHour, sendUntilHour } = this.config;
    const rows = await this.deps.repo.list(clinicId, new Date(now.getTime() - 30 * 86_400_000));
    return {
      schedule: `das ${sendFromHour}h às ${sendUntilHour}h`,
      rows: rows.map((r) => ({
        id: r.id,
        patientId: r.patientId,
        patientName: r.patientName,
        patientPhone: maskPhone(r.phone),
        procedureName: r.procedureName,
        until: r.until.toISOString(),
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        closedAt: r.closedAt?.toISOString() ?? null,
        offers: r.offers,
        lastOffer: r.lastOffer
          ? { startsAt: r.lastOffer.startsAt.toISOString(), answer: r.lastOffer.answer }
          : null,
      })),
    };
  }

  /** The front desk puts a patient on the list until a day (inclusive). */
  async add(clinicId: string, body: unknown, now: Date): Promise<{ id: string }> {
    const parsed = addBodySchema.safeParse(body);
    if (!parsed.success) throw new WaitlistError(422, "Pedido inválido.");
    const clinic = await this.deps.repo.clinic(clinicId);
    if (!clinic) throw new WaitlistError(404, "Clínica não encontrada.");
    const today = dateInZone(now, clinic.timeZone);
    if (parsed.data.until < today || parsed.data.until > addDays(today, this.config.maxDays))
      throw new WaitlistError(
        422,
        `Escolha um dia entre hoje e os próximos ${this.config.maxDays} dias.`,
      );
    const until = zonedToUtc(addDays(parsed.data.until, 1), 0, clinic.timeZone);
    const out = await this.deps.repo.add(
      clinicId,
      parsed.data.patientId,
      parsed.data.procedureId,
      until,
    );
    if (!out) throw new WaitlistError(404, "Paciente ou procedimento não encontrado.");
    if (!out.created)
      throw new WaitlistError(409, "Esse paciente já está na lista para esse procedimento.");
    this.deps.logger.info({ entryId: out.id }, "waitlist entry added by staff");
    return { id: out.id };
  }

  /** The patient asked the bot. Keeps an existing entry for the same procedure. */
  async join(clinicId: string, patientId: string, procedureId: string, until: Date) {
    const out = await this.deps.repo.add(clinicId, patientId, procedureId, until);
    if (out?.created) this.deps.logger.info({ entryId: out.id }, "waitlist entry added by patient");
    return out;
  }

  async remove(clinicId: string, entryId: string, now: Date) {
    if (!(await this.deps.repo.close(clinicId, entryId, "REMOVED", now)))
      throw new WaitlistError(404, "Esse paciente não está mais na lista de espera.");
    this.deps.logger.info({ entryId }, "waitlist entry removed by staff");
  }

  async run(now: Date): Promise<{ sent: number }> {
    const { repo, logger } = this.deps;
    let sent = 0;
    for (const clinic of await repo.clinicsWaiting()) {
      await repo.expire(clinic.id, now);
      const hour = Math.floor(minuteOfDayInZone(now, clinic.timeZone) / 60);
      if (hour < this.config.sendFromHour || hour >= this.config.sendUntilHour) continue;
      const agenda = await this.deps.agendaFor(clinic.id);
      if (!agenda) continue;
      sent += await this.offerFreeSlots(clinic, agenda, await repo.waiting(clinic.id), now);
    }
    if (sent) logger.info({ sent }, "waitlist offers");
    return { sent };
  }

  private async offerFreeSlots(
    clinic: WaitlistClinic,
    agenda: AgendaProvider,
    entries: WaitingEntry[],
    now: Date,
  ) {
    const hold = new Date(now.getTime() - this.config.holdMinutes * 60_000);
    const today = dateInZone(now, clinic.timeZone);
    const offered = new Set<string>();
    /** Earliest upcoming appointment of each patient, per procedure. */
    const booked = new Map<string, Map<string, Date>>();
    const earliestBooked = async (patientId: string, procedureId: string) => {
      if (!booked.has(patientId)) {
        const mine = new Map<string, Date>();
        for (const a of await agenda.consultasDoPaciente({ patientId, from: now }))
          if (ACTIVE.has(a.status) && !mine.has(a.procedureId)) mine.set(a.procedureId, a.startsAt);
        booked.set(patientId, mine);
      }
      return booked.get(patientId)!.get(procedureId);
    };

    let sent = 0;
    for (const procedureId of new Set(entries.map((e) => e.procedureId))) {
      const line = entries.filter((e) => e.procedureId === procedureId);
      const latest = Math.max(...line.map((e) => e.until.getTime()));
      const lastDay = dateInZone(new Date(latest - 1), clinic.timeZone);
      const days = Math.min(
        this.config.maxDays,
        Math.round((Date.parse(lastDay) - Date.parse(today)) / 86_400_000) + 1,
      );
      const slots = await agenda.listarHorarios({ procedureId, from: today, days });
      for (const slot of slots) {
        if (slot.startsAt.getTime() >= latest) break;
        if (await this.deps.repo.slotOfferedSince(slot.dentistId, slot.startsAt, hold)) continue;
        let given = 0;
        for (const entry of line) {
          if (given >= this.config.perSlot) break;
          if (offered.has(entry.id) || slot.startsAt >= entry.until) continue;
          if (entry.lastOfferAt && entry.lastOfferAt > hold) continue;
          const mine = await earliestBooked(entry.patientId, procedureId);
          if (mine && mine <= slot.startsAt) continue;
          const offerId = await this.deps.repo.createOffer(entry.id, slot, now);
          if (!offerId) continue;
          offered.add(entry.id);
          try {
            await this.sendOffer(clinic, entry, slot, offerId, now);
            given++;
            sent++;
          } catch (err) {
            await this.deps.repo.deleteOffer(offerId);
            this.deps.logger.error(
              { entryId: entry.id, err: err instanceof Error ? err.message : "unknown" },
              "waitlist offer failed",
            );
          }
        }
      }
    }
    return sent;
  }

  private async sendOffer(
    clinic: WaitlistClinic,
    entry: WaitingEntry,
    slot: Slot,
    offerId: string,
    now: Date,
  ) {
    const { channel, store } = this.deps;
    const conv = await store.getOrCreateConversation(clinic.id, entry.phone);
    const msg: OutboundMessage = {
      kind: "template",
      to: conv.contact,
      template: "vaga_disponivel",
      params: [
        firstName(entry.patientName),
        entry.procedureName,
        clinic.name,
        formatWhenPtBr(slot.startsAt, clinic.timeZone),
      ],
      buttonPayloads: waitlistButtons(offerId),
    };
    const { waMessageId } = await channel.send(msg);
    await store.saveMessage({
      conversationId: conv.id,
      waMessageId,
      direction: "OUTBOUND",
      type: msg.kind,
      body: previewText(msg),
      at: now,
    });
  }

  /**
   * The patient tapped a button of an offer. Returns the reply and, when the front desk must
   * look at it, a handoff reason.
   */
  async answer(
    clinicId: string,
    contact: string,
    offerId: string,
    accept: boolean,
    now: Date,
  ): Promise<{ text: string; handoff?: string }> {
    const { repo, logger } = this.deps;
    const offer = await repo.offer(clinicId, offerId);
    if (!offer || offer.phone !== contact)
      return { text: WAITLIST_MESSAGES.notFound, handoff: "waitlist:not_found" };
    if (offer.answer) return { text: WAITLIST_MESSAGES.answered };
    if (offer.entryStatus !== "WAITING") return { text: WAITLIST_MESSAGES.closed };
    if (!accept) {
      await repo.setAnswer(offer.id, "DECLINED", now);
      logger.info({ offerId }, "waitlist offer declined");
      return { text: WAITLIST_MESSAGES.declined };
    }

    const agenda = await this.deps.agendaFor(clinicId);
    if (!agenda) return { text: WAITLIST_MESSAGES.notFound, handoff: "waitlist:no_agenda" };
    // Closing first makes the entry the lock: a second offer of the same entry cannot also book.
    if (!(await repo.close(clinicId, offer.entryId, "BOOKED", now)))
      return { text: WAITLIST_MESSAGES.closed };
    const existing = (await agenda.consultasDoPaciente({ patientId: offer.patientId, from: now }))
      .filter((a) => a.procedureId === offer.procedureId && ACTIVE.has(a.status))
      .at(0);
    if (existing && existing.startsAt <= offer.startsAt) {
      await repo.settle(offer.entryId, "REMOVED", now);
      await repo.setAnswer(offer.id, "DECLINED", now);
      return { text: WAITLIST_MESSAGES.alreadyEarlier(offer.procedureName) };
    }
    const slot: Slot = {
      dentistId: offer.dentistId,
      procedureId: offer.procedureId,
      startsAt: offer.startsAt,
      endsAt: offer.endsAt,
    };
    let appointmentId: string;
    try {
      if (existing) {
        await agenda.remarcar({ appointmentId: existing.id, patientId: offer.patientId, slot });
        appointmentId = existing.id;
      } else {
        ({ appointmentId } = await agenda.reservar({ patientId: offer.patientId, slot }));
      }
    } catch (err) {
      await repo.settle(offer.entryId, "WAITING", now);
      if (!(err instanceof SlotUnavailableError)) throw err;
      await repo.setAnswer(offer.id, "TAKEN", now);
      logger.info({ offerId }, "waitlist offer already taken");
      return { text: WAITLIST_MESSAGES.taken };
    }
    await repo.setAnswer(offer.id, "ACCEPTED", now);
    await repo.settle(offer.entryId, "BOOKED", now, appointmentId);
    logger.info({ offerId, appointmentId }, "waitlist offer accepted");
    const when = formatWhenPtBr(offer.startsAt, agenda.timeZone);
    return {
      text: existing
        ? WAITLIST_MESSAGES.moved(offer.procedureName, when)
        : WAITLIST_MESSAGES.booked(offer.procedureName, when),
    };
  }
}

/** "quinta-feira, 22/10": the last day a patient waits for, as the bot tells them. */
export function describeUntil(until: Date, timeZone: string) {
  return formatDayPtBr(new Date(until.getTime() - 1), timeZone);
}
