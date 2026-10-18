import { api } from "@/lib/api";
import { FirstAccessForm, LoginForm } from "./forms";

export const dynamic = "force-dynamic";

/** E-mail and password; before the clinic has any login, the dentist's first access. */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ aviso?: string }>;
}) {
  const { aviso } = await searchParams;
  const { hasUsers } = await api.staffStatus();
  return (
    <main id="conteudo" style={{ maxWidth: 380, paddingTop: 80 }}>
      <h1>Painel DentalBOT</h1>
      {aviso ? <p className="notice">{aviso}</p> : null}
      {hasUsers ? <LoginForm /> : <FirstAccessForm />}
    </main>
  );
}
