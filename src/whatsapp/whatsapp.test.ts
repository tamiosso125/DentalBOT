import { describe, expect, it } from "vitest";
import { isValidSignature, signBody } from "./signature.js";
import { renderTemplate, TEMPLATES } from "./templates.js";
import { toCloudApiBody } from "./channel.js";

describe("signature", () => {
  it("accepts only the right secret", () => {
    const body = '{"a":1}';
    const sig = signBody(body, "secret-123");
    expect(isValidSignature(body, sig, "secret-123")).toBe(true);
    expect(isValidSignature(body, sig, "other")).toBe(false);
    expect(isValidSignature(body, undefined, "secret-123")).toBe(false);
    expect(isValidSignature(body, "sha256=zz", "secret-123")).toBe(false);
  });
});

describe("templates", () => {
  it("renders and checks param count", () => {
    expect(renderTemplate("lembrete_consulta", ["Ana", "seg 10h", "Clínica"])).toContain("Ana");
    expect(() => renderTemplate("lembrete_consulta", ["Ana"])).toThrow();
  });

  it("keeps marketing to the recall invitation, which always offers a way out", () => {
    const marketing = Object.values(TEMPLATES).filter((t) => t.category !== "UTILITY");
    expect(marketing.map((t) => t.name)).toEqual(["convite_retorno"]);
    expect(TEMPLATES.convite_retorno.buttons).toContain("Não quero receber");
  });

  it("builds Cloud API bodies", () => {
    const body = toCloudApiBody({
      kind: "template",
      to: "5511900000001",
      template: "confirmacao_consulta",
      params: ["Ana", "Clínica", "seg 10h"],
    });
    expect(body).toMatchObject({ type: "template", template: { language: { code: "pt_BR" } } });
  });
});
