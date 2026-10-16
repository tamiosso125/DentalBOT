import { describe, expect, it } from "vitest";
import { passwordProblem, roleLabel } from "./staff";

describe("staff helpers", () => {
  it("names the role in pt-BR", () => {
    expect(roleLabel("DENTIST")).toBe("Dentista");
    expect(roleLabel("RECEPTION")).toBe("Recepção");
  });

  it("checks the new password and its confirmation", () => {
    expect(passwordProblem("curta", "curta")).toBe("A senha precisa de pelo menos 10 caracteres.");
    expect(passwordProblem("senha-longa-1", "senha-longa-2")).toBe(
      "As duas senhas não são iguais.",
    );
    expect(passwordProblem("senha-longa-1", "senha-longa-1")).toBeNull();
  });
});
