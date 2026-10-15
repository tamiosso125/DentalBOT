/** Display helpers for attendance marking. Data comes from GET /admin/attendance. */

import type { AgendaRow } from "./api";

export type Attendance = {
  pending: AgendaRow[];
  month: { attended: number; noShow: number };
};

/** Share of marked appointments this month that were missed, in whole percent; null if none marked. */
export function noShowRate(month: Attendance["month"]): number | null {
  const total = month.attended + month.noShow;
  return total === 0 ? null : Math.round((month.noShow / total) * 100);
}

/** Attendance can be marked (or corrected) once the appointment has started, unless cancelled. */
export function canMarkAttendance(a: { startsAt: string; status: string }, now = new Date()) {
  return a.status !== "CANCELLED" && new Date(a.startsAt) <= now;
}
