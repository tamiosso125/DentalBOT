import Link from "next/link";
import { currentUser } from "@/lib/current-user";
import { roleLabel } from "@/lib/staff";
import { logout } from "./actions";

export async function Nav() {
  const user = await currentUser();
  return (
    <header className="top">
      <strong>DentalBOT</strong>
      <nav>
        <Link href="/">Agenda</Link>
        <Link href="/pacientes">Pacientes</Link>
        <Link href="/resumo">Resumo</Link>
        <Link href="/orcamentos">Orçamentos</Link>
        <Link href="/cobrancas">Cobranças</Link>
        <Link href="/autorizacoes">Autorizações</Link>
        <Link href="/espera">Lista de espera</Link>
        <Link href="/retorno">Retorno</Link>
        <Link href="/dados">Dados (LGPD)</Link>
        <Link href="/acessos">Acessos</Link>
        <Link href="/clinica">Clínica</Link>
        {user?.role === "DENTIST" ? <Link href="/equipe">Equipe</Link> : null}
      </nav>
      <form action={logout} style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {user ? (
          <Link href="/conta" title="Minha senha">
            {user.name} ({roleLabel(user.role)})
          </Link>
        ) : null}
        <button type="submit" className="secondary">
          Sair
        </button>
      </form>
    </header>
  );
}
