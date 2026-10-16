/** Clinical record (evolução clínica) helpers. Data comes from GET /admin/patients/:id/clinical-records. */

export type ClinicalEntryData = {
  performed: string;
  teeth: string[];
  notes: string | null;
};

export type ClinicalEntry = {
  id: string;
  at: string;
  appointmentId: string;
  appointmentAt: string;
  procedure: string;
  signedBy: string | null;
  amendsId: string | null;
  data: ClinicalEntryData;
};

export type ClinicalEntryBody = ClinicalEntryData & {
  appointmentId?: string;
  amendsId?: string;
};

/** "36, 37 46" -> ["36", "37", "46"], without repeats. The API checks they are real teeth. */
export function parseTeeth(raw: string): string[] {
  return [...new Set(raw.split(/[\s,;]+/).filter(Boolean))];
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

/** The visit form (or the addendum form) as the API expects it. */
export function entryFromForm(
  form: FormData,
  target: { appointmentId: string } | { amendsId: string },
): ClinicalEntryBody {
  return {
    ...target,
    performed: text(form, "performed"),
    teeth: parseTeeth(text(form, "teeth")),
    notes: text(form, "notes") || null,
  };
}

/** Only a signed-in dentist writes the clinical record. */
export function canWriteClinical(user: { role: string } | null): boolean {
  return user?.role === "DENTIST";
}

export type EntryThread = { entry: ClinicalEntry; addenda: ClinicalEntry[] };

/** Entries (oldest first from the API) grouped by visit, newest visit first; an addendum follows its entry. */
export function threadsByVisit(entries: ClinicalEntry[]): Array<{
  appointmentId: string;
  appointmentAt: string;
  procedure: string;
  threads: EntryThread[];
}> {
  const originals = entries.filter((e) => e.amendsId === null);
  const root = (e: ClinicalEntry): string => {
    let cur = e;
    while (cur.amendsId) {
      const up = entries.find((x) => x.id === cur.amendsId);
      if (!up) break;
      cur = up;
    }
    return cur.id;
  };
  const visits = new Map<string, ReturnType<typeof threadsByVisit>[number]>();
  for (const o of originals) {
    const v = visits.get(o.appointmentId) ?? {
      appointmentId: o.appointmentId,
      appointmentAt: o.appointmentAt,
      procedure: o.procedure,
      threads: [],
    };
    v.threads.push({
      entry: o,
      addenda: entries.filter((e) => e.amendsId !== null && root(e) === o.id),
    });
    visits.set(o.appointmentId, v);
  }
  return [...visits.values()].sort((a, b) => b.appointmentAt.localeCompare(a.appointmentAt));
}
