import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrorSummary } from "./error-summary";

describe("ErrorSummary", () => {
  it("renders nothing without errors", () => {
    expect(renderToStaticMarkup(<ErrorSummary />)).toBe("");
    expect(renderToStaticMarkup(<ErrorSummary errors={[]} />)).toBe("");
  });

  it("announces every error under a title", () => {
    const html = renderToStaticMarkup(
      <ErrorSummary errors={["Informe o nome.", "CPF inválido."]} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Revise antes de continuar");
    expect(html).toContain("Informe o nome.");
    expect(html).toContain("CPF inválido.");
  });
});
