import { describe, expect, it } from "vitest";
import { checkReply } from "./guard.js";

const allowed = {
  allowedTimes: new Set(["08:00", "14:00", "18:00"]),
  allowedPrices: new Set([90000]),
};

describe("checkReply", () => {
  it("accepts times and prices that came from tools", () => {
    expect(checkReply("Clareamento: R$ 900,00. Tenho às 14:00 ou às 8h.", allowed)).toEqual({
      ok: true,
    });
    expect(checkReply("Atendemos das 8h às 18h.", allowed)).toEqual({ ok: true });
  });

  it("blocks invented times", () => {
    expect(checkReply("Tenho amanhã às 07:30!", allowed)).toEqual({ ok: false, reason: "time" });
    expect(checkReply("Posso te encaixar às 10h", allowed)).toEqual({ ok: false, reason: "time" });
  });

  it("does not treat durations as clock times", () => {
    expect(checkReply("Mandamos lembrete 24h antes e respondemos em 1h.", allowed)).toEqual({
      ok: true,
    });
  });

  it("blocks prices outside the table, with or without cents", () => {
    expect(checkReply("Sai por R$ 500", allowed)).toEqual({ ok: false, reason: "price" });
    expect(checkReply("Sai por R$ 1.200,00", allowed)).toEqual({ ok: false, reason: "price" });
  });

  it("blocks personal data", () => {
    expect(checkReply("Seu CPF 529.982.247-25 está ok", allowed)).toEqual({
      ok: false,
      reason: "personal_data",
    });
    expect(checkReply("Ligue 11 90000-0001", allowed)).toEqual({
      ok: false,
      reason: "personal_data",
    });
  });
});
