import { describe, expect, it } from "vitest";
import { answerRate, averageLabel, RATING_LABEL } from "./survey";

describe("survey helpers", () => {
  it("writes the average with a decimal comma", () => {
    expect(averageLabel(null)).toBe("-");
    expect(averageLabel(4.6)).toBe("4,6");
    expect(averageLabel(5)).toBe("5,0");
  });

  it("rates answers over surveys sent", () => {
    const month = { sent: 0, answers: 0, average: null, byRating: [0, 0, 0, 0, 0] as const };
    expect(answerRate({ ...month, byRating: [0, 0, 0, 0, 0] })).toBeNull();
    expect(answerRate({ ...month, sent: 3, answers: 2, byRating: [0, 0, 0, 1, 1] })).toBe(67);
  });

  it("labels each rating like the template buttons", () => {
    expect([1, 2, 3, 4, 5].map((n) => RATING_LABEL[n])).toEqual([
      "1 - Péssimo",
      "2 - Ruim",
      "3 - Regular",
      "4 - Bom",
      "5 - Excelente",
    ]);
  });
});
