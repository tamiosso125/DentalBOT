import { describe, expect, it } from "vitest";
import {
  findSensitiveData,
  textFromToolInput,
} from "../plugins/dentalbot-dev/hooks/sensitive-patterns.mjs";

describe("dentalbot-dev PreToolUse hook", () => {
  it("allows fictitious test data", () => {
    expect(findSensitiveData('cpf "529.982.247-25", tel 5511900000001, (11) 90000-1234')).toEqual(
      [],
    );
  });

  it("flags real-looking CPF, phones and tokens", () => {
    // Built at runtime so this file itself does not trip the hook.
    const cpf = ["111.444", "777-35"].join(".");
    const phone = ["+55 21 9", "8888-7777"].join("");
    const fakeAsaasKey = ["$aact", "prod", "0".repeat(30)].join("_");
    const findings = findSensitiveData(`cpf ${cpf} tel ${phone} key ${fakeAsaasKey}`);
    expect(findings).toHaveLength(3);
  });

  it("reads MultiEdit inputs", () => {
    expect(textFromToolInput({ edits: [{ new_string: "a" }, { new_string: "b" }] })).toBe("a\nb");
  });
});
