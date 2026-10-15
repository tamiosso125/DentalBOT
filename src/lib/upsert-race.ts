import { Prisma } from "@prisma/client";

/**
 * Runs a Prisma upsert, retrying once when a concurrent call created the same row first.
 * Postgres can reject one of two simultaneous upserts on a unique key (P2002); by the
 * retry the row exists, so the upsert takes its update branch.
 */
export async function upsertRace<T>(upsert: () => Promise<T>): Promise<T> {
  try {
    return await upsert();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
      return upsert();
    throw err;
  }
}
