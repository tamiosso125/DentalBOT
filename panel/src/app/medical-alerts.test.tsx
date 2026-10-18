import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgendaAlerts, MedicalAlerts } from "./medical-alerts";

describe("MedicalAlerts", () => {
  it("renders nothing when there is no alert", () => {
    expect(renderToStaticMarkup(<MedicalAlerts alerts={[]} />)).toBe("");
  });

  it("lists every alert with a title that does not depend on colour", () => {
    const html = renderToStaticMarkup(
      <MedicalAlerts alerts={["Alergia a penicilina", "Usa anticoagulante"]} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Atenção antes de atender");
    expect(html).toContain("Alergia a penicilina");
    expect(html).toContain("Usa anticoagulante");
  });

  it("links to the full anamnesis when given the address", () => {
    const html = renderToStaticMarkup(
      <MedicalAlerts alerts={["Gestante"]} anamnesisHref="/pacientes/p1/anamnese" />,
    );
    expect(html).toContain('href="/pacientes/p1/anamnese"');
  });
});

describe("AgendaAlerts", () => {
  it("renders nothing when there is no alert", () => {
    expect(renderToStaticMarkup(<AgendaAlerts alerts={[]} />)).toBe("");
  });

  it("lists each alert as text under the patient", () => {
    const html = renderToStaticMarkup(<AgendaAlerts alerts={["Usa anticoagulante", "Gestante"]} />);
    expect(html).toContain('aria-label="Alertas de saúde"');
    expect(html).toContain("Usa anticoagulante");
    expect(html).toContain("Gestante");
  });
});
