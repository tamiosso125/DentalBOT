import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

/** Tokens declared in the block that starts with `selector {`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]),
  );
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const themes = {
  light: tokens(":root"),
  dark: tokens(':root[data-theme="dark"]'),
};

describe.each(Object.entries(themes))("%s theme contrast (WCAG 2.2 AA)", (_name, t) => {
  it("keeps text readable on the page and on cards", () => {
    for (const color of ["text", "muted", "accent", "danger", "ok", "warn"]) {
      expect(ratio(t[color]!, t.bg!), `${color} on bg`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t[color]!, t.surface!), `${color} on surface`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps field borders visible (3:1)", () => {
    expect(ratio(t["field-border"]!, t.bg!)).toBeGreaterThanOrEqual(3);
  });

  it("keeps button text readable", () => {
    expect(ratio(t["accent-text"]!, t.accent!)).toBeGreaterThanOrEqual(4.5);
  });
});

it("repeats the dark tokens for the automatic and the manual dark theme", () => {
  const auto = tokens(':root:not([data-theme="light"])');
  expect(auto).toEqual(themes.dark);
});
