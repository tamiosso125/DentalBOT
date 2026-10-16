import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import type { FieldCipher } from "../privacy/index.js";
import type { StaffActor } from "../staff/staff.js";

/**
 * Clinical record (evolução clínica): what the dentist did in each visit, which teeth and
 * observations. Each entry is signed by the dentist who wrote it and is never edited or
 * deleted; a correction is an addendum that points at the entry it amends. The text is health
 * data, so it is stored encrypted and never logged. The bot and the LLM never read it.
 */

/** FDI tooth numbers: permanent 11-48 and deciduous 51-85. */
const TOOTH = /^(?:[1-4][1-8]|[5-8][1-5])$/;

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: `Texto longo demais (até ${max} caracteres).` })
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .default(null);

export const clinicalEntrySchema = z.strictObject({
  performed: z
    .string()
    .trim()
    .min(1, { message: "Escreva o que foi feito." })
    .max(2000, { message: "Texto longo demais (até 2000 caracteres)." }),
  teeth: z
    .array(z.string().regex(TOOTH, { message: "Dente inválido (use a numeração FDI, ex.: 36)." }))
    .max(52)
    .default([]),
  notes: text(2000),
});
export type ClinicalEntryData = z.infer<typeof clinicalEntrySchema>;

const createSchema = clinicalEntrySchema.extend({
  appointmentId: z.string().min(1).max(64).optional(),
  /** The entry this one corrects. */
  amendsId: z.string().min(1).max(64).optional(),
});

export type ClinicalEntryRow = {
  id: string;
  at: string;
  appointmentId: string;
  appointmentAt: string;
  procedure: string;
  /** The dentist who signed it, null if the login no longer exists. */
  signedBy: string | null;
  /** Set when this entry corrects an earlier one. */
  amendsId: string | null;
  data: ClinicalEntryData;
};

export class ClinicalRecordError extends Error {
  constructor(
    readonly status: 403 | 404 | 422,
    message: string,
  ) {
    super(message);
    this.name = "ClinicalRecordError";
  }
}

/** Decodes an entry; the schema fills the defaults for fields added later. */
export function openClinicalEntry(cipher: FieldCipher, encrypted: string): ClinicalEntryData {
  return clinicalEntrySchema.parse(JSON.parse(cipher.decrypt(encrypted)));
}

export class ClinicalRecords {
  constructor(private readonly deps: { db: PrismaClient; cipher: FieldCipher; logger: Logger }) {}

  /** Oldest first, so an addendum reads after the entry it corrects. */
  async list(clinicId: string, patientId: string): Promise<ClinicalEntryRow[]> {
    const rows = await this.deps.db.clinicalEntry.findMany({
      where: { clinicId, patientId },
      orderBy: { createdAt: "asc" },
      take: 500,
      include: {
        staffUser: { select: { name: true } },
        appointment: { select: { startsAt: true, procedure: { select: { name: true } } } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      appointmentId: r.appointmentId,
      appointmentAt: r.appointment.startsAt.toISOString(),
      procedure: r.appointment.procedure.name,
      signedBy: r.staffUser?.name ?? null,
      amendsId: r.amendsId,
      data: openClinicalEntry(this.deps.cipher, r.dataEncrypted),
    }));
  }

  /**
   * Signs a new entry for a visit that was attended, or an addendum to an earlier entry
   * (the addendum belongs to the same visit). Only a signed-in dentist can write.
   */
  async add(clinicId: string, patientId: string, by: StaffActor, input: unknown, now: Date) {
    if (by.role !== "DENTIST")
      throw new ClinicalRecordError(403, "Só a dentista registra a evolução clínica.");
    const r = createSchema.safeParse(input);
    if (!r.success)
      throw new ClinicalRecordError(422, r.error.issues[0]?.message ?? "Registro inválido.");
    const { amendsId, appointmentId: asked, ...entry } = r.data;
    const db = this.deps.db;

    const patient = await db.patient.findFirst({
      where: { id: patientId, clinicId, anonymizedAt: null },
      select: { id: true },
    });
    if (!patient) throw new ClinicalRecordError(404, "Paciente não encontrado.");

    let appointmentId = asked;
    if (amendsId) {
      const original = await db.clinicalEntry.findFirst({
        where: { id: amendsId, clinicId, patientId },
        select: { appointmentId: true },
      });
      if (!original) throw new ClinicalRecordError(404, "Registro não encontrado.");
      if (appointmentId && appointmentId !== original.appointmentId)
        throw new ClinicalRecordError(422, "O adendo precisa ser da mesma consulta.");
      appointmentId = original.appointmentId;
    }
    if (!appointmentId) throw new ClinicalRecordError(422, "Escolha a consulta.");
    const appointment = await db.appointment.findFirst({
      where: { id: appointmentId, clinicId, patientId },
      select: { status: true },
    });
    if (!appointment) throw new ClinicalRecordError(404, "Consulta não encontrada.");
    if (appointment.status !== "COMPLETED")
      throw new ClinicalRecordError(
        422,
        "A evolução só pode ser registrada depois de marcar que o paciente compareceu.",
      );

    const row = await db.clinicalEntry.create({
      data: {
        clinicId,
        patientId,
        appointmentId,
        amendsId: amendsId ?? null,
        dataEncrypted: this.deps.cipher.encrypt(JSON.stringify(entry)),
        staffUserId: by.id,
        createdAt: now,
      },
      select: { id: true },
    });
    this.deps.logger.info(
      { clinicId, patientId, appointmentId, entryId: row.id, amendsId: amendsId ?? null },
      "clinical entry signed",
    );
    return { id: row.id };
  }
}
