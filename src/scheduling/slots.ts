import { weekdayOf, zonedToUtc } from "./time.js";

export type WorkingWindow = { weekday: number; startMinute: number; endMinute: number };
export type BusyInterval = { startsAt: Date; endsAt: Date };

export type SlotQuery = {
  /** Calendar date in the clinic timezone, "YYYY-MM-DD". */
  date: string;
  timeZone: string;
  workingHours: WorkingWindow[];
  /** Existing appointments and schedule blocks. */
  busy: BusyInterval[];
  durationMinutes: number;
  /** Granularity of offered start times. */
  stepMinutes?: number;
  /** Slots starting before now + minNoticeMinutes are not offered. */
  now?: Date;
  minNoticeMinutes?: number;
};

/** Free start times for one dentist on one day. Pure function: easy to test and reuse. */
export function availableSlots(q: SlotQuery): Date[] {
  const step = q.stepMinutes ?? 30;
  const earliest = q.now ? q.now.getTime() + (q.minNoticeMinutes ?? 60) * 60_000 : -Infinity;
  const weekday = weekdayOf(q.date);
  const slots: Date[] = [];

  for (const w of q.workingHours.filter((h) => h.weekday === weekday)) {
    for (let start = w.startMinute; start + q.durationMinutes <= w.endMinute; start += step) {
      const startsAt = zonedToUtc(q.date, start, q.timeZone);
      const endsAt = new Date(startsAt.getTime() + q.durationMinutes * 60_000);
      if (startsAt.getTime() < earliest) continue;
      const overlaps = q.busy.some((b) => startsAt < b.endsAt && endsAt > b.startsAt);
      if (!overlaps) slots.push(startsAt);
    }
  }
  return slots.sort((a, b) => a.getTime() - b.getTime());
}
