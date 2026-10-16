import { describe, expect, it } from "vitest";
import { aftercareLine } from "./aftercare";

describe("aftercareLine", () => {
  it("is empty without instructions sent", () => {
    expect(aftercareLine({ sent: 0, checkIns: 0, ok: 0, help: 0 })).toBeNull();
  });

  it("counts the answers to the check-in", () => {
    expect(aftercareLine({ sent: 1, checkIns: 0, ok: 0, help: 0 })).toBe(
      "1 paciente recebeu os cuidados",
    );
    expect(aftercareLine({ sent: 5, checkIns: 4, ok: 2, help: 1 })).toBe(
      "5 pacientes receberam os cuidados · 2 tudo bem · 1 pediram ajuda · 1 sem resposta",
    );
  });
});
