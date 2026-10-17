/** Patient registration form: what the panel sends to POST /admin/patients/:id/profile. */

export type ProfileBody = {
  name: string;
  birthDate: string | null;
  /** Absent = keep the CPF on file; null = remove it. */
  cpf?: string | null;
};

export type NewPatientBody = {
  name: string;
  phone: string;
  birthDate: string | null;
  cpf?: string;
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

/** The registration form: the phone is required, the CPF is sent only when typed. */
export function newPatientFromForm(form: FormData): NewPatientBody {
  const cpf = text(form, "cpf");
  const body: NewPatientBody = {
    name: text(form, "name"),
    phone: text(form, "phone"),
    birthDate: text(form, "birthDate") || null,
  };
  if (cpf) body.cpf = cpf;
  return body;
}
