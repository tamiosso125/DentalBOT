import Link from "next/link";
import { notFound } from "next/navigation";
import { api } from "@/lib/api";
import { Nav } from "../../../nav";
import { updateProcedure } from "../../actions";
import { ProcedureFields } from "../../procedure-fields";
import { SetupForm } from "../../setup-form";

export const dynamic = "force-dynamic";

export default async function ProcedurePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const procedure = (await api.setup()).procedures.find((p) => p.id === id);
  if (!procedure) notFound();

  return (
    <>
      <Nav />
      <main id="conteudo">
        <p>
          <Link href="/clinica">← Cadastro da clínica</Link>
        </p>
        <h1>{procedure.name}</h1>
        <section className="card">
          <SetupForm action={updateProcedure.bind(null, procedure.id)} submit="Salvar">
            <ProcedureFields procedure={procedure} />
            <p className="muted" style={{ margin: 0 }}>
              Mudar preço ou duração vale para as próximas conversas e orçamentos. Consultas já
              marcadas e orçamentos enviados não mudam. Um procedimento inativo some do bot, mas
              continua no histórico.
            </p>
          </SetupForm>
        </section>
      </main>
    </>
  );
}
