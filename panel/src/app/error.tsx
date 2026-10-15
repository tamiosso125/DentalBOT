"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main>
      <h1>Algo deu errado</h1>
      <p className="muted">
        O painel não conseguiu falar com o DentalBOT. Confira se a API está no ar e tente de novo.
      </p>
      <button type="button" onClick={reset}>
        Tentar de novo
      </button>
    </main>
  );
}
