"use client";

import Link from "next/link";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main id="conteudo">
      <h1>Não foi possível carregar esta página</h1>
      <p className="error-summary" role="alert">
        O painel não conseguiu falar com o DentalBOT. Nada foi perdido. Confira se a API está no ar
        e tente de novo.
      </p>
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={reset}>
          Tentar de novo
        </button>
        <Link className="button secondary" href="/">
          Ir para a agenda
        </Link>
      </p>
    </main>
  );
}
