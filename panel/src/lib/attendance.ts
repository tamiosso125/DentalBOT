/** Display helpers for attendance marking. Data comes from GET /admin/attendance. */

import type { AgendaRow } from "./api";

export type Attendance = {
  pending: AgendaRow[];
  month: {
    attended: number;
    noShow: number;
    /** "We missed you" messages the bot sent this month. */
    noShowNotices: number;
    /** Of those, patients who booked again afterwards. */
    rebooked: number;
  };
};

/** Share of marked appointments this month that were missed, in whole percent; null if none marked. */
export function noShowRate(month: Pick<Attendance["month"], "attended" | "noShow">): number | null {
  const total = month.attended + month.noShow;
  return total === 0 ? null : Math.round((month.noShow / total) * 100);
}

/** Attendance can be marked (or corrected) once the appointment has started, unless cancelled. */
export function canMarkAttendance(a: { startsAt: string; status: string }, now = new Date()) {
  return a.status !== "CANCELLED" && new Date(a.startsAt) <= now;
}

/** "1 paciente que faltou recebeu o convite para remarcar; 1 marcou de novo", or null if none. */
export function noShowFollowUpLabel(month: Attendance["month"]): string | null {
  const n = month.noShowNotices;
  if (n === 0) return null;
  const who = n === 1 ? "1 paciente que faltou recebeu" : `${n} pacientes que faltaram receberam`;
  const back = month.rebooked === 1 ? "1 marcou" : `${month.rebooked} marcaram`;
  return `${who} o convite para remarcar; ${back} de novo`;
}
