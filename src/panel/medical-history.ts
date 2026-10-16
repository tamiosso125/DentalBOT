import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import type { FieldCipher } from "../privacy/index.js";

/**
 * Medical history (anamnese) filled in by the staff in the panel. The whole form is health
 * data, stored encrypted as JSON. Every save is a new version, so earlier answers stay for
 * the record. The bot and the LLM never read it, and it never goes to the patient.
 */

export const CONDITIONS = [
  "DIABETES",
  "HYPERTENSION",
  "HEART_DISEASE",
  "BLEEDING_DISORDER",
  "ASTHMA",
  "EPILEPSY",
  "HEPATITIS",
  "KIDNEY_DISEASE",
] as const;
export type Condition = (typeof CONDITIONS)[number];

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: `Texto longo demais (até ${max} caracteres).` })
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .default(null);

export const medicalHistorySchema = z.strictObject({
  /** null = no known allergy. */
  allergies: text(500),
  medications: text(500),
  conditions: z.array(z.enum(CONDITIONS)).max(CONDITIONS.length).default([]),
  anticoagulant: z.boolean().default(false),
  pregnant: z.boolean().default(false),
  smoker: z.boolean().default(false),
  surgeries: text(500),
  notes: text(1000),
});
export type MedicalHistoryData = z.infer<typeof medicalHistorySchema>;

export type MedicalHistoryVersion = {
  id: string;
  at: string;
  /** Who filled it in, when signed in with a personal login. */
  staffName: string | null;
  data: MedicalHistoryData;
};

export type MedicalHistoryView = {
  /** Newest first, at most 20; the first one is the current history. */
  versions: MedicalHistoryVersion[];
  alerts: string[];
};

/** What the dentist must see before treating, in short pt-BR phrases. */
export function medicalAlerts(d: MedicalHistoryData): string[] {
  const alerts: string[] = [];
  if (d.allergies) alerts.push(`Alergia: ${d.allergies}`);
  if (d.anticoagulant) alerts.push("Usa anticoagulante");
  if (d.conditions.includes("BLEEDING_DISORDER")) alerts.push("Problema de coagulação");
  if (d.conditions.includes("HEART_DISEASE")) alerts.push("Problema cardíaco");
  if (d.pregnant) alerts.push("Gestante");
  return alerts;
}

export class MedicalHistoryError extends Error {
  constructor(
    readonly status: 404 | 422,
    message: string,
  ) {
    super(message);
    this.name = "MedicalHistoryError";
  }
}

export class MedicalHistories {
  constructor(private readonly deps: { db: PrismaClient; cipher: FieldCipher; logger: Logger }) {}

  async view(clinicId: string, patientId: string): Promise<MedicalHistoryView> {
    const rows = await this.deps.db.medicalHistory.findMany({
      where: { clinicId, patientId },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { staffUser: { select: { name: true } } },
    });
    const versions = rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      staffName: r.staffUser?.name ?? null,
      data: this.open(r.dataEncrypted),
    }));
    return { versions, alerts: versions[0] ? medicalAlerts(versions[0].data) : [] };
  }

  /** Alerts from the current history only; [] when none was filled in. */
  async alerts(clinicId: string, patientId: string): Promise<string[]> {
    const r = await this.deps.db.medicalHistory.findFirst({
      where: { clinicId, patientId },
      orderBy: { createdAt: "desc" },
      select: { dataEncrypted: true },
    });
    return r ? medicalAlerts(this.open(r.dataEncrypted)) : [];
  }

  async save(clinicId: string, patientId: string, input: unknown, now: Date, staffUserId?: string) {
    const r = medicalHistorySchema.safeParse(input);
    if (!r.success)
      throw new MedicalHistoryError(422, r.error.issues[0]?.message ?? "Anamnese inválida.");
    const patient = await this.deps.db.patient.findFirst({
      where: { id: patientId, clinicId, anonymizedAt: null },
      select: { id: true },
    });
    if (!patient) throw new MedicalHistoryError(404, "Paciente não encontrado.");
    const row = await this.deps.db.medicalHistory.create({
      data: {
        clinicId,
        patientId,
        dataEncrypted: this.deps.cipher.encrypt(JSON.stringify(r.data)),
        staffUserId: staffUserId ?? null,
        createdAt: now,
      },
      select: { id: true },
    });
    this.deps.logger.info({ clinicId, patientId, historyId: row.id }, "medical history saved");
    return { id: row.id };
  }

  /** Older versions may lack fields added later: the schema fills the defaults. */
  private open(encrypted: string): MedicalHistoryData {
    return openMedicalHistory(this.deps.cipher, encrypted);
  }
}

/** Shared by the record, the appointment detail and the LGPD export. */
export function openMedicalHistory(cipher: FieldCipher, encrypted: string): MedicalHistoryData {
  return medicalHistorySchema.parse(JSON.parse(cipher.decrypt(encrypted)));
}
