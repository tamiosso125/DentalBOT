import { z } from "zod";

/**
 * Orchestrator working memory, persisted per conversation between messages.
 * Holds only ids and times: the model refers to "option 2" or "appointment 1" and the
 * tools resolve them here, so it never types a time or an id itself.
 */
const offer = z.object({
  n: z.number().int(),
  dentistId: z.string(),
  procedureId: z.string(),
  procedureName: z.string(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
});

const appointmentRef = z.object({
  n: z.number().int(),
  appointmentId: z.string(),
  procedureName: z.string(),
  startsAt: z.iso.datetime(),
});

export const agentStateSchema = z.object({
  offers: z.array(offer).default([]),
  appointments: z.array(appointmentRef).default([]),
  updatedAt: z.iso.datetime().optional(),
});

export type AgentState = z.infer<typeof agentStateSchema>;
export type Offer = z.infer<typeof offer>;

/** Offers older than this are dropped: the agenda has likely changed. */
const STATE_TTL_MS = 6 * 60 * 60_000;

export function emptyState(): AgentState {
  return { offers: [], appointments: [] };
}

export function loadState(raw: unknown, now: Date): AgentState {
  const parsed = agentStateSchema.safeParse(raw ?? {});
  if (!parsed.success) return emptyState();
  const s = parsed.data;
  if (s.updatedAt && now.getTime() - Date.parse(s.updatedAt) > STATE_TTL_MS) return emptyState();
  return s;
}
