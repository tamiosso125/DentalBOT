import { describe, expect, it } from "vitest";
import { profileFromForm } from "./patient-profile";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("profileFromForm", () => {
  it("trims the name and keeps the CPF on file when the field is empty", () => {
    expect(
      profileFromForm(form({ name: "  Maria Souza ", birthDate: "1990-03-15", cpf: "" })),
    ).toEqual({ name: "Maria Souza", birthDate: "1990-03-15" });
  });

  it("sends a new CPF as typed and clears an empty birth date", () => {
    expect(profileFromForm(form({ name: "Maria", birthDate: "", cpf: "529.982.247-25" }))).toEqual({
      name: "Maria",
      birthDate: null,
      cpf: "529.982.247-25",
    });
  });

  it("removes the CPF when asked, even if one was typed", () => {
    expect(
      profileFromForm(
        form({ name: "Maria", birthDate: "", cpf: "529.982.247-25", removeCpf: "on" }),
      ),
    ).toEqual({ name: "Maria", birthDate: null, cpf: null });
  });
});
