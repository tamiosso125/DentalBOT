import Link from "next/link";
import { Nav } from "../../nav";
import { createPatient } from "./actions";
import { NewPatientForm } from "./new-patient-form";

export const dynamic = "force-dynamic";

/** Registers a patient who has not talked to the bot yet. */
export default function NewPatientPage() {
  return (
    <>
      <Nav />
      <main id="conteudo">
        <p>
          <Link href="/pacientes">← Pacientes</Link>
        </p>
        <h1>Cadastrar paciente</h1>
        <section className="card">
          <NewPatientForm action={createPatient} />
          <p className="muted">
            O celular não pode ser trocado depois: é a identidade do paciente no WhatsApp. O
            cadastro não dá consentimento para convites de retorno; isso é registrado em "Retorno".
          </p>
        </section>
      </main>
    </>
  );
}
