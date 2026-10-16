import { describe, expect, it } from "vitest";
import { foldText, nameMatches, parseBirthDate } from "./search-text.js";

describe("foldText and nameMatches", () => {
  it("ignores accents, case and extra spaces", () => {
    expect(foldText("  JOSÉ  da Conceição ")).toBe("jose da conceicao");
    expect(nameMatches("José da Conceição", "jose")).toBe(true);
    expect(nameMatches("Jose Silva", "JOSÉ")).toBe(true);
    expect(nameMatches("João Ávila", "avila joao")).toBe(true);
  });

  it("needs every word, and rejects an empty search", () => {
    expect(nameMatches("Maria Exemplo", "maria silva")).toBe(false);
    expect(nameMatches("Maria Exemplo", "  ")).toBe(false);
  });
});

describe("parseBirthDate", () => {
  it("reads dd/mm/yyyy and yyyy-mm-dd", () => {
    expect(parseBirthDate("15/03/1990")).toBe("1990-03-15");
    expect(parseBirthDate(" 1990-03-15 ")).toBe("1990-03-15");
  });

  it("refuses what is not a real date", () => {
    expect(parseBirthDate("31/02/1990")).toBeNull();
    expect(parseBirthDate("15/03/90")).toBeNull();
    expect(parseBirthDate("maria")).toBeNull();
  });
});
