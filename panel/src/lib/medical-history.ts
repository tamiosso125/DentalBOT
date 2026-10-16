/** Anamnese form helpers. Data comes from GET /admin/patients/:id/medical-history. */

export const CONDITIONS = [
  "DIABETES",
  "HYPERTENSION",
  "HEART_DISEASE",
  "BLEEDING_DISORDER",
  "ASTHMA",
  "EPILEPSY",
  "HEPATITIS",
  "KIDNEY_DISEASE",
] as const;
export type Condition = (typeof CONDITIONS)[number];

export const CONDITION_LABEL: Record<Condition, string> = {
  DIABETES: "Diabetes",
  HYPERTENSION: "Pressão alta",
  HEART_DISEASE: "Problema cardíaco",
  BLEEDING_DISORDER: "Problema de coagulação",
  ASTHMA: "Asma",
  EPILEPSY: "Epilepsia",
  HEPATITIS: "Hepatite",
  KIDNEY_DISEASE: "Problema renal",
};

export type MedicalHistoryData = {
  allergies: string | null;
  medications: string | null;
  conditions: Condition[];
  anticoagulant: boolean;
  pregnant: boolean;
  smoker: boolean;
  surgeries: string | null;
  notes: string | null;
};

export type MedicalHistoryView = {
  /** Newest first; the first one is the current history. */
  versions: Array<{ id: string; at: string; staffName: string | null; data: MedicalHistoryData }>;
  alerts: string[];
};

export const EMPTY_HISTORY: MedicalHistoryData = {
  allergies: null,
  medications: null,
  conditions: [],
  anticoagulant: false,
  pregnant: false,
  smoker: false,
  surgeries: null,
  notes: null,
};

const text = (form: FormData, key: string) => {
  const v = String(form.get(key) ?? "").trim();
  return v === "" ? null : v;
};

/** The form as the API expects it. Unknown condition values are dropped. */
export function historyFromForm(form: FormData): MedicalHistoryData {
  const picked = new Set(form.getAll("conditions").map(String));
  return {
    allergies: text(form, "allergies"),
    medications: text(form, "medications"),
    conditions: CONDITIONS.filter((c) => picked.has(c)),
    anticoagulant: form.get("anticoagulant") === "on",
    pregnant: form.get("pregnant") === "on",
    smoker: form.get("smoker") === "on",
    surgeries: text(form, "surgeries"),
    notes: text(form, "notes"),
  };
}

/** One line for a version in the history list, e.g. "Alergia: Dipirona · Diabetes · Fumante". */
export function historySummary(d: MedicalHistoryData): string {
  const parts: string[] = [];
  if (d.allergies) parts.push(`Alergia: ${d.allergies}`);
  else parts.push("Sem alergia informada");
  if (d.medications) parts.push(`Remédios: ${d.medications}`);
  if (d.anticoagulant) parts.push("Anticoagulante");
  for (const c of d.conditions) parts.push(CONDITION_LABEL[c]);
  if (d.pregnant) parts.push("Gestante");
  if (d.smoker) parts.push("Fumante");
  if (d.surgeries) parts.push(`Cirurgias: ${d.surgeries}`);
  return parts.join(" · ");
}
