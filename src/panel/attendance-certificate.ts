import type { PrismaClient } from "@prisma/client";
import PDFDocument from "pdfkit";
import type { Logger } from "../lib/logger.js";
import { ddmmyyyy } from "../quotes/quote-pdf.js";
import { dateInZone, formatTimePtBr } from "../scheduling/time.js";

/**
 * Attendance certificate (atestado de comparecimento): a one-page PDF the front desk hands to
 * a patient who needs to show an employer or school that they came to the clinic. It says who
 * came, when, and the dentist; never the procedure or any health information. Days off or a
 * diagnosis code are the dentist's to write, outside the bot.
 */

export type CertificateData = {
  clinicName: string;
  clinicAddress: string | null;
  patientName: string;
  dentistName: string;
  dentistCro: string | null;
  /** The appointment's day in the clinic's calendar, YYYY-MM-DD. */
  day: string;
  /** Scheduled start and end, HH:MM in the clinic's timezone. */
  from: string;
  to: string;
  /** The day the certificate is issued, YYYY-MM-DD. */
  issuedOn: string;
};

export class AttendanceCertificateError extends Error {
  constructor(
    readonly status: 404 | 422,
    message: string,
  ) {
    super(message);
    this.name = "AttendanceCertificateError";
  }
}

/** The sentence the patient hands over. Kept apart from the layout so tests can read it. */
export function certificateText(d: CertificateData): string {
  return (
    `Atesto, para os devidos fins, que ${d.patientName} compareceu a esta clínica para ` +
    `atendimento odontológico no dia ${ddmmyyyy(d.day)}, com consulta agendada das ${d.from} ` +
    `às ${d.to}.`
  );
}

/** Renders the certificate as a one-page A4 PDF. Built-in Helvetica covers pt-BR accents. */
export function renderCertificatePdf(
  d: CertificateData,
  opts: { compress?: boolean } = {},
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: 60,
    compress: opts.compress ?? true,
    info: { Title: `Atestado de comparecimento ${d.clinicName}`, Author: d.clinicName },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.font("Helvetica-Bold").fontSize(18).text(d.clinicName, { align: "center" });
  if (d.clinicAddress)
    doc.font("Helvetica").fontSize(10).fillColor("#555").text(d.clinicAddress, { align: "center" });
  doc.fillColor("#000").moveDown(3);

  doc.font("Helvetica-Bold").fontSize(15).text("ATESTADO DE COMPARECIMENTO", { align: "center" });
  doc.moveDown(2);
  doc.font("Helvetica").fontSize(12).text(certificateText(d), { align: "justify", lineGap: 4 });
  doc.moveDown(2);
  doc.text(`Emitido em ${ddmmyyyy(d.issuedOn)}.`);

  doc.moveDown(5);
  const x = (doc.page.width - 260) / 2;
  const y = doc.y;
  doc
    .moveTo(x, y)
    .lineTo(x + 260, y)
    .strokeColor("#000")
    .stroke();
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(d.dentistName, x, y + 6, {
      width: 260,
      align: "center",
    });
  if (d.dentistCro)
    doc.font("Helvetica").text(d.dentistCro, x, doc.y, { width: 260, align: "center" });

  doc.end();
  return done;
}

export class AttendanceCertificates {
  constructor(private readonly deps: { db: PrismaClient; logger: Logger }) {}

  /** The PDF for an attended visit of this clinic. */
  async pdf(clinicId: string, appointmentId: string, now: Date): Promise<Buffer> {
    const a = await this.deps.db.appointment.findFirst({
      where: { id: appointmentId, clinicId },
      select: {
        status: true,
        startsAt: true,
        endsAt: true,
        patient: { select: { name: true, anonymizedAt: true } },
        dentist: { select: { name: true, cro: true } },
        clinic: { select: { name: true, address: true, timezone: true } },
      },
    });
    if (!a) throw new AttendanceCertificateError(404, "Consulta não encontrada.");
    if (a.status !== "COMPLETED")
      throw new AttendanceCertificateError(
        422,
        "O atestado só sai depois de marcar que o paciente compareceu.",
      );
    if (a.patient.anonymizedAt)
      throw new AttendanceCertificateError(
        422,
        "Os dados deste paciente foram anonimizados a pedido dele.",
      );
    const tz = a.clinic.timezone;
    const pdf = await renderCertificatePdf({
      clinicName: a.clinic.name,
      clinicAddress: a.clinic.address,
      patientName: a.patient.name,
      dentistName: a.dentist.name,
      dentistCro: a.dentist.cro,
      day: dateInZone(a.startsAt, tz),
      from: formatTimePtBr(a.startsAt, tz),
      to: formatTimePtBr(a.endsAt, tz),
      issuedOn: dateInZone(now, tz),
    });
    this.deps.logger.info({ clinicId, appointmentId }, "attendance certificate issued");
    return pdf;
  }
}
