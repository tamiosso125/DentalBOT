import Link from "next/link";

export default function NotFound() {
  return (
    <main id="conteudo">
      <h1>Página não encontrada</h1>
      <p className="muted">
        Esse endereço não existe ou o registro foi removido. Volte para a agenda e continue por lá.
      </p>
      <Link className="button" href="/">
        Ir para a agenda
      </Link>
    </main>
  );
}
