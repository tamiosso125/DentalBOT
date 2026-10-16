import { describe, expect, it } from "vitest";
import {
  certificateText,
  renderCertificatePdf,
  type CertificateData,
} from "./attendance-certificate.js";

const data: CertificateData = {
  clinicName: "Clínica Sorriso",
  clinicAddress: "Rua das Flores, 100",
  patientName: "Maria Silva",
  dentistName: "Dra. Ana Exemplo",
  dentistCro: "CRO-SP 12345",
  day: "2026-10-20",
  from: "09:00",
  to: "09:30",
  issuedOn: "2026-10-21",
};

describe("attendance certificate", () => {
  it("says who came, when, and nothing about the treatment", () => {
    expect(certificateText(data)).toBe(
      "Atesto, para os devidos fins, que Maria Silva compareceu a esta clínica para atendimento odontológico no dia 20/10/2026, com consulta agendada das 09:00 às 09:30.",
    );
  });

  it("renders a one-page PDF, with or without the CRO and the address", async () => {
    const pdf = await renderCertificatePdf(data, { compress: false });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.subarray(-6).toString()).toContain("%%EOF");
    expect(pdf.toString("latin1").match(/\/Type \/Page\b/g)).toHaveLength(1);
    const bare = await renderCertificatePdf(
      { ...data, dentistCro: null, clinicAddress: null },
      { compress: false },
    );
    expect(bare.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
