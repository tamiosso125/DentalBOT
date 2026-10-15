import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCases, runCase } from "./support/eval.js";

describe("conversation cases", () => {
  for (const { file, data } of loadCases(join(import.meta.dirname, "conversations"))) {
    it(`${data.name} (${file})`, async () => {
      const result = await runCase(file, data);
      expect(result.failures).toEqual([]);
    });
  }
});
