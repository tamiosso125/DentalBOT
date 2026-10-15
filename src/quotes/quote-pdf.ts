import PDFDocument from "pdfkit";
import { formatCents } from "../lib/money.js";
import type { QuoteView } from "./quote-repository.js";

/** Splits the private total into installments; the remainder (cents) goes to the first. */
export function splitInstallments(totalCents: number, count: number): number[] {
  if (count < 1 || !Number.isInteger(count)) throw new Error("installment count must be >= 1");
  const base = Math.floor(totalCents / count);
  return Array.from({ length: count }, (_, i) =>
    i === 0 ? totalCents - base * (count - 1) : base,
  );
}

export const ddmmyyyy = (date: string) => date.split("-").reverse().join("/");

/** Patient-facing summary (pt-BR), shared by the PDF and the WhatsApp message. */
export function quoteSummary(q: QuoteView) {
  const rows = q.items.map((i) => ({
    description: i.description,
    quantity: i.quantity,
    unit: i.coverage === "INSURANCE" ? "convênio" : formatCents(i.unitPriceCents),
    total: i.coverage === "INSURANCE" ? "coberto" : formatCents(i.unitPriceCents * i.quantity),
  }));
  const parts = splitInstallments(q.totalCents, q.installmentCount);
  const plan =
    q.totalCents === 0
      ? "Sem valor particular a pagar."
      : q.installmentCount === 1
        ? `À vista: ${formatCents(q.totalCents)}`
        : parts.every((p) => p === parts[0])
          ? `${q.installmentCount}x de ${formatCents(parts[0]!)}`
          : `${q.installmentCount}x: 1ª de ${formatCents(parts[0]!)} e as demais de ${formatCents(parts[1]!)}`;
  const hasInsurance = q.items.some((i) => i.coverage === "INSURANCE");
  return {
    rows,
    total: formatCents(q.totalCents),
    plan,
    validUntil: q.validUntil ? ddmmyyyy(q.validUntil) : null,
    hasInsurance,
  };
}

/** Renders the quote as a one-page A4 PDF. Built-in Helvetica covers pt-BR accents. */
export function renderQuotePdf(q: QuoteView, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const s = quoteSummary(q);
  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    compress: opts.compress ?? true,
    info: {
      Title: `Orçamento ${q.clinicName}`,
      Author: q.clinicName,
      CreationDate: q.createdAt,
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.font("Helvetica-Bold").fontSize(18).text(q.clinicName);
  if (q.clinicAddress) doc.font("Helvetica").fontSize(10).fillColor("#555").text(q.clinicAddress);
  doc.moveDown(1.5).fillColor("#000");

  doc.font("Helvetica-Bold").fontSize(14).text("Orçamento de tratamento");
  doc.font("Helvetica").fontSize(10);
  doc.text(`Paciente: ${q.patientName}`);
  doc.text(`Dentista: ${q.dentistName}${q.dentistCro ? ` (${q.dentistCro})` : ""}`);
  doc.text(`Emitido em: ${q.createdAt.toISOString().slice(0, 10).split("-").reverse().join("/")}`);
  if (s.validUntil) doc.text(`Válido até: ${s.validUntil}`);
  doc.moveDown();

  const cols = [50, 300, 350, 440];
  const header = (y: number) => {
    doc.font("Helvetica-Bold").fontSize(10);
    doc.text("Procedimento", cols[0]!, y, { width: 240 });
    doc.text("Qtd", cols[1]!, y, { width: 40, align: "right" });
    doc.text("Valor unit.", cols[2]!, y, { width: 80, align: "right" });
    doc.text("Total", cols[3]!, y, { width: 100, align: "right" });
    doc
      .moveTo(50, y + 14)
      .lineTo(545, y + 14)
      .strokeColor("#999")
      .stroke();
  };
  let y = doc.y;
  header(y);
  y += 22;
  doc.font("Helvetica").fontSize(10);
  for (const r of s.rows) {
    const h = doc.heightOfString(r.description, { width: 240 });
    doc.text(r.description, cols[0]!, y, { width: 240 });
    doc.text(String(r.quantity), cols[1]!, y, { width: 40, align: "right" });
    doc.text(r.unit, cols[2]!, y, { width: 80, align: "right" });
    doc.text(r.total, cols[3]!, y, { width: 100, align: "right" });
    y += Math.max(h, 12) + 8;
  }
  doc.moveTo(50, y).lineTo(545, y).strokeColor("#999").stroke();
  y += 10;
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .text(`Total particular: ${s.total}`, 50, y, { width: 495, align: "right" });
  doc
    .font("Helvetica")
    .fontSize(10)
    .text(`Pagamento: ${s.plan} (Pix, boleto ou cartão)`, { width: 495, align: "right" });
  doc.moveDown(1.5);

  doc.x = 50;
  if (q.notes) {
    doc.font("Helvetica-Bold").text("Observações");
    doc.font("Helvetica").text(q.notes, { width: 495 });
    doc.moveDown();
  }
  doc.fontSize(8).fillColor("#555");
  if (s.hasInsurance)
    doc.text(
      "Itens marcados como convênio dependem de elegibilidade e autorização da operadora, conferidas pela recepção.",
      { width: 495 },
    );
  doc.text(
    "Valores em reais. Este orçamento não substitui a avaliação clínica e pode mudar se o plano de tratamento mudar.",
    { width: 495 },
  );

  doc.end();
  return done;
}
