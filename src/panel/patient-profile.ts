import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import { isValidCpf, normalizeCpf, type FieldCipher } from "../privacy/index.js";
import { parseBirthDate } from "../lib/search-text.js";

/**
 * The front desk fixes a patient's registration data: name, birth date and CPF. The CPF is
 * stored as hash + encrypted text and never logged; the phone is not editable here because it
 * is the patient's WhatsApp identity.
 */

const NAME_MAX = 120;

export const profileSchema = z.strictObject({
  name: z.string().trim().min(2).max(NAME_MAX).optional(),
  /** YYYY-MM-DD or DD/MM/YYYY; null clears it. */
  birthDate: z.string().trim().min(1).nullable().optional(),
  /** Any CPF format; null clears it. Absent = unchanged. */
  cpf: z.string().trim().min(1).nullable().optional(),
});

export class PatientProfileError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "PatientProfileError";
  }
}

export class PatientProfiles {
  constructor(private readonly deps: { db: PrismaClient; cipher: FieldCipher; logger: Logger }) {}

  async update(clinicId: string, patientId: string, input: unknown, now: Date) {
    const r = profileSchema.safeParse(input);
    if (!r.success) throw new PatientProfileError(422, "Confira o nome, o nascimento e o CPF.");
    const { name, birthDate, cpf } = r.data;
    if (name === undefined && birthDate === undefined && cpf === undefined)
      throw new PatientProfileError(422, "Nada para alterar.");

    const patient = await this.deps.db.patient.findFirst({
      where: { id: patientId, clinicId },
      select: { id: true, anonymizedAt: true },
    });
    if (!patient) throw new PatientProfileError(404, "Paciente não encontrado.");
    if (patient.anonymizedAt)
      throw new PatientProfileError(
        422,
        "Os dados deste paciente foram anonimizados a pedido dele.",
      );

    const data: {
      name?: string;
      birthDate?: Date | null;
      cpfHash?: string | null;
      cpfEncrypted?: string | null;
    } = {};
    if (name !== undefined) data.name = name;

    if (birthDate !== undefined) {
      if (birthDate === null) data.birthDate = null;
      else {
        const day = parseBirthDate(birthDate);
        const date = day ? new Date(`${day}T00:00:00.000Z`) : null;
        if (!date || Number.isNaN(date.getTime()) || date > now || day! < "1900-01-01")
          throw new PatientProfileError(422, "Data de nascimento inválida.");
        data.birthDate = date;
      }
    }

    if (cpf !== undefined) {
      if (cpf === null) {
        data.cpfHash = null;
        data.cpfEncrypted = null;
      } else {
        if (!isValidCpf(cpf)) throw new PatientProfileError(422, "CPF inválido.");
        const digits = normalizeCpf(cpf);
        const hash = this.deps.cipher.hash(digits);
        const taken = await this.deps.db.patient.findFirst({
          where: { clinicId, cpfHash: hash, anonymizedAt: null, id: { not: patientId } },
          select: { id: true },
        });
        if (taken) throw new PatientProfileError(409, "Já existe outro paciente com este CPF.");
        data.cpfHash = hash;
        data.cpfEncrypted = this.deps.cipher.encrypt(digits);
      }
    }

    await this.deps.db.patient.update({ where: { id: patientId }, data });
    this.deps.logger.info(
      { clinicId, patientId, fields: Object.keys(data).filter((k) => k !== "cpfEncrypted") },
      "patient profile updated",
    );
  }
}
