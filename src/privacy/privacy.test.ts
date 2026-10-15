import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FieldCipher, isValidCpf, maskPhone, normalizePhone, redact, REDACTED } from "./index.js";

describe("redact", () => {
  it("drops sensitive keys and patterns", () => {
    const out = redact({
      cpf: "529.982.247-25",
      note: "ligar para 11 90000-4321 ou paciente@email.com, CPF 52998224725",
      nested: { text: { body: "estou com dor" }, ok: 1 },
    });
    expect(out.cpf).toBe(REDACTED);
    expect(out.note).not.toMatch(/90000-4321|email\.com|52998224725/);
    expect(out.nested.text).toBe(REDACTED);
    expect(out.nested.ok).toBe(1);
  });

  it("redacts error messages", () => {
    const out = redact(new Error("falhou para 5511900004321")) as unknown as { message: string };
    expect(out.message).toBe(`falhou para ${REDACTED}`);
  });

  it("masks phones", () => {
    expect(maskPhone("+55 11 90000-4321")).toBe("***4321");
  });
});

describe("FieldCipher", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "x".repeat(32));

  it("round-trips and uses a fresh IV", () => {
    const a = cipher.encrypt("5511900004321");
    const b = cipher.encrypt("5511900004321");
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe("5511900004321");
  });

  it("rejects tampered payloads", () => {
    const enc = cipher.encrypt("segredo");
    const parts = enc.split(".");
    parts[3] = Buffer.from("outro").toString("base64url");
    expect(() => cipher.decrypt(parts.join("."))).toThrow();
  });

  it("hashes deterministically", () => {
    expect(cipher.hash("5511900004321")).toBe(cipher.hash("5511900004321"));
  });
});

describe("identifiers", () => {
  it("normalizes phones", () => {
    expect(normalizePhone("(11) 90000-4321")).toBe("5511900004321");
    expect(normalizePhone("+55 11 90000-4321")).toBe("5511900004321");
    expect(() => normalizePhone("123")).toThrow();
  });

  it("validates CPF", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true);
    expect(isValidCpf("529.982.247-24")).toBe(false);
    expect(isValidCpf("111.111.111-11")).toBe(false);
  });
});
