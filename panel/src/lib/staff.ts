/** Staff logins ("Equipe"). Data comes from GET /admin/staff. */
import type { StaffRole } from "./session";

export type StaffRow = {
  id: string;
  name: string;
  role: StaffRole;
  email: string;
  active: boolean;
  lastLoginAt: string | null;
};

export const PASSWORD_MIN = 10;

export function roleLabel(role: StaffRole): string {
  return role === "DENTIST" ? "Dentista" : "Recepção";
}

/** What is wrong with a new password and its confirmation, or null when fine. */
export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN)
    return `A senha precisa de pelo menos ${PASSWORD_MIN} caracteres.`;
  if (password !== confirm) return "As duas senhas não são iguais.";
  return null;
}
