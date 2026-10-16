import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("staff passwords", () => {
  it("verifies the right password only, with a fresh salt each time", async () => {
    const a = await hashPassword("senha-da-recepcao");
    const b = await hashPassword("senha-da-recepcao");
    expect(a).not.toBe(b);
    expect(a).not.toContain("senha");
    expect(await verifyPassword("senha-da-recepcao", a)).toBe(true);
    expect(await verifyPassword("senha-da-recepção", a)).toBe(false);
    expect(await verifyPassword("senha-da-recepcao", "texto-qualquer")).toBe(false);
  });
});
