import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import { isValidCpf, normalizeCpf, normalizePhone, type FieldCipher } from "../privacy/index.js";
import { parseBirthDate } from "../lib/search-text.js";

/**
 * The front desk registers a patient (someone who phoned or walked in) and fixes registration
 * data: name, birth date and CPF. The CPF is stored as hash + encrypted text and never logged;
 * the phone is set only when registering because it is the patient's WhatsApp identity.
 */

const NAME_MAX = 120;

export const profileSchema = z.strictObject({
  name: z.string().trim().min(2).max(NAME_MAX).optional(),
  /** YYYY-MM-DD or DD/MM/YYYY; null clears it. */
  birthDate: z.string().trim().min(1).nullable().optional(),
  /** Any CPF format; null clears it. Absent = unchanged. */
  cpf: z.string().trim().min(1).nullable().optional(),
});

export const newPatientSchema = z.strictObject({
  name: z.string().trim().min(2).max(NAME_MAX),
  /** Mobile with area code, any format. It becomes the patient's WhatsApp identity. */
  phone: z.string().trim().min(8).max(25),
  birthDate: z.string().trim().min(1).nullable().optional(),
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

/** YYYY-MM-DD or DD/MM/YYYY to a date; null/undefined stay null. Refuses future and pre-1900 dates. */
function parseBirth(text: string | null | undefined, now: Date): Date | null {
  if (text === null || text === undefined) return null;
  const day = parseBirthDate(text);
  const date = day ? new Date(`${day}T00:00:00.000Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date > now || day! < "1900-01-01")
    throw new PatientProfileError(422, "Data de nascimento inválida.");
  return date;
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

    if (birthDate !== undefined) data.birthDate = parseBirth(birthDate, now);

    if (cpf !== undefined) {
      Object.assign(data, await this.cpfFields(clinicId, cpf, patientId));
    }

    await this.deps.db.patient.update({ where: { id: patientId }, data });
    this.deps.logger.info(
      { clinicId, patientId, fields: Object.keys(data).filter((k) => k !== "cpfEncrypted") },
      "patient profile updated",
    );
  }

  /** Registers a patient at the front desk, e.g. someone who phoned or walked in. */
  async create(clinicId: string, input: unknown, now: Date) {
    const r = newPatientSchema.safeParse(input);
    if (!r.success)
      throw new PatientProfileError(422, "Confira o nome, o celular, o nascimento e o CPF.");
    let phone: string;
    try {
      phone = normalizePhone(r.data.phone);
    } catch {
      throw new PatientProfileError(422, "Celular inválido: informe com DDD.");
    }
    const birthDate = parseBirth(r.data.birthDate, now);
    const cpf =
      r.data.cpf === undefined ? {} : await this.cpfFields(clinicId, r.data.cpf, undefined);
    const phoneHash = this.deps.cipher.hash(phone);
    const taken = await this.deps.db.patient.findUnique({
      where: { clinicId_phoneHash: { clinicId, phoneHash } },
      select: { id: true },
    });
    if (taken) throw new PatientProfileError(409, "Já existe um paciente com este celular.");
    const created = await this.deps.db.patient
      .create({
        data: {
          clinicId,
          name: r.data.name,
          phoneHash,
          phoneEncrypted: this.deps.cipher.encrypt(phone),
          birthDate,
          ...cpf,
        },
        select: { id: true },
      })
      .catch((err: unknown) => {
        // Two people registering the same phone at once.
        if ((err as { code?: string }).code === "P2002")
          throw new PatientProfileError(409, "Já existe um paciente com este celular.");
        throw err;
      });
    this.deps.logger.info({ clinicId, patientId: created.id }, "patient registered by staff");
    return { id: created.id };
  }

  /** Hash + encrypted digits for a CPF, nulls to clear it. Refuses a CPF another patient has. */
  private async cpfFields(clinicId: string, cpf: string | null, selfId: string | undefined) {
    if (cpf === null) return { cpfHash: null, cpfEncrypted: null };
    if (!isValidCpf(cpf)) throw new PatientProfileError(422, "CPF inválido.");
    const digits = normalizeCpf(cpf);
    const hash = this.deps.cipher.hash(digits);
    const taken = await this.deps.db.patient.findFirst({
      where: {
        clinicId,
        cpfHash: hash,
        anonymizedAt: null,
        ...(selfId ? { id: { not: selfId } } : {}),
      },
      select: { id: true },
    });
    if (taken) throw new PatientProfileError(409, "Já existe outro paciente com este CPF.");
    return { cpfHash: hash, cpfEncrypted: this.deps.cipher.encrypt(digits) };
  }
}
