import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ErrorPage from "./error";
import Loading from "./loading";
import NotFound from "./not-found";

describe("page states", () => {
  it("announces the loading state without hiding the main landmark", () => {
    const html = renderToStaticMarkup(<Loading />);
    expect(html).toContain('id="conteudo"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Carregando");
  });

  it("explains a failure as an alert and offers a way out", () => {
    const html = renderToStaticMarkup(<ErrorPage error={new Error("x")} reset={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Tentar de novo");
    expect(html).toContain('href="/"');
  });

  it("answers a missing page in Portuguese", () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain("Página não encontrada");
    expect(html).toContain('href="/"');
  });
});
