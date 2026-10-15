import Link from "next/link";
import { logout } from "./actions";

export function Nav() {
  return (
    <header className="top">
      <strong>DentalBOT</strong>
      <nav>
        <Link href="/">Agenda</Link>
        <Link href="/orcamentos">Orçamentos</Link>
        <Link href="/dados">Dados (LGPD)</Link>
        <Link href="/clinica">Clínica</Link>
      </nav>
      <form action={logout}>
        <button type="submit" className="secondary">
          Sair
        </button>
      </form>
    </header>
  );
}
