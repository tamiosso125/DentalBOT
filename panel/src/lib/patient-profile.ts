/** Patient registration form: what the panel sends to POST /admin/patients/:id/profile. */

export type ProfileBody = {
  name: string;
  birthDate: string | null;
  /** Absent = keep the CPF on file; null = remove it. */
  cpf?: string | null;
};

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export function profileFromForm(form: FormData): ProfileBody {
  const cpf = text(form, "cpf");
  const body: ProfileBody = {
    name: text(form, "name"),
    birthDate: text(form, "birthDate") || null,
  };
  if (form.get("removeCpf") === "on") body.cpf = null;
  else if (cpf) body.cpf = cpf;
  return body;
}
