import Link from "next/link";
import { notFound } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { Nav } from "../../../nav";
import { saveProfile } from "./actions";
import { ProfileForm } from "./profile-form";

export const dynamic = "force-dynamic";

/** Corrects the registration data the bot collected: name, birth date and CPF. */
export default async function EditPatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api.patientRecord(id).catch((err) => {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  });
  const p = r.patient;
  if (p.anonymizedAt) notFound();

  return (
    <>
      <Nav />
      <main>
        <p>
          <Link href={`/pacientes/${encodeURIComponent(p.id)}`}>← {p.name}</Link>
        </p>
        <h1>Corrigir dados</h1>
        <section className="card">
          <ProfileForm
            action={saveProfile.bind(null, p.id)}
            name={p.name}
            birthDate={p.birthDate}
            hasCpf={p.hasCpf}
          />
          <p className="muted">
            O CPF fica criptografado. O celular não muda aqui: é a identidade do paciente no
            WhatsApp.
          </p>
        </section>
      </main>
    </>
  );
}
