/** Shown while a page fetches its data, so a slow API does not look like a frozen screen. */
export default function Loading() {
  return (
    <main id="conteudo" aria-busy="true">
      <p className="muted" role="status">
        Carregando...
      </p>
    </main>
  );
}
