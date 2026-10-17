import { describe, expect, it } from "vitest";
import { isActive, navGroups } from "./nav-groups";

const hrefs = (role?: string) => navGroups(role).flatMap((g) => g.links.map((l) => l.href));

describe("navGroups", () => {
  it("keeps the old pages reachable and groups them by task", () => {
    expect(navGroups("DENTIST").map((g) => g.title)).toEqual([
      "Hoje",
      "Pacientes",
      "Financeiro",
      "Clínica",
    ]);
    expect(hrefs("DENTIST")).toEqual(
      expect.arrayContaining([
        "/",
        "/pendencias",
        "/pacientes",
        "/resumo",
        "/orcamentos",
        "/cobrancas",
        "/autorizacoes",
        "/espera",
        "/retorno",
        "/dados",
        "/acessos",
        "/clinica",
        "/equipe",
      ]),
    );
  });

  it("hides the dentist-only pages from the reception", () => {
    const reception = hrefs("RECEPTION");
    for (const href of ["/resumo", "/acessos", "/equipe"]) {
      expect(reception).not.toContain(href);
    }
    expect(reception).toContain("/clinica");
  });
});

describe("isActive", () => {
  it("matches sub-paths but not the home page for everything", () => {
    expect(isActive("/pacientes/abc", "/pacientes")).toBe(true);
    expect(isActive("/pacientes", "/pacientes")).toBe(true);
    expect(isActive("/pacientes-x", "/pacientes")).toBe(false);
    expect(isActive("/pacientes", "/")).toBe(false);
    expect(isActive("/", "/")).toBe(true);
  });
});
