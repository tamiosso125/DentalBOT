import { Queue, Worker } from "bullmq";
import type { Logger } from "../lib/logger.js";

export type JobHandler<T> = (payload: T) => Promise<void>;

/** Webhooks only enqueue; work happens in the handler, off the request path. */
export interface JobQueue<T> {
  enqueue(payload: T, opts?: { jobId?: string }): Promise<void>;
  close(): Promise<void>;
}

/** Runs jobs in-process. Fine for dev and tests; jobs are lost on restart. */
export class InMemoryQueue<T> implements JobQueue<T> {
  private pending = new Set<Promise<void>>();
  private seen = new Set<string>();

  constructor(
    private readonly handler: JobHandler<T>,
    private readonly logger: Logger,
  ) {}

  async enqueue(payload: T, opts?: { jobId?: string }) {
    if (opts?.jobId) {
      if (this.seen.has(opts.jobId)) return;
      this.seen.add(opts.jobId);
    }
    const p = Promise.resolve()
      .then(() => this.handler(payload))
      .catch((err: unknown) => this.logger.error({ err }, "in-memory job failed"))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Waits for every job enqueued so far (tests). */
  async drain() {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  async close() {
    await this.drain();
  }
}

/** BullMQ on Redis: retries with backoff and survives restarts. */
export class BullQueue<T> implements JobQueue<T> {
  private readonly queue: Queue;
  private readonly worker: Worker;

  constructor(
    name: string,
    redisUrl: string,
    handler: JobHandler<T>,
    logger: Logger,
    concurrency = 5,
  ) {
    const connection = { url: redisUrl, maxRetriesPerRequest: null };
    this.queue = new Queue(name, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    });
    this.worker = new Worker(name, async (job) => handler(job.data as T), {
      connection,
      concurrency,
    });
    this.worker.on("failed", (job, err) =>
      logger.error({ queue: name, jobId: job?.id, attempts: job?.attemptsMade, err }, "job failed"),
    );
  }

  async enqueue(payload: T, opts?: { jobId?: string }) {
    // jobId dedupes Meta/Asaas redeliveries while the job is still known to Redis.
    // BullMQ rejects custom ids containing ":".
    const jobId = opts?.jobId?.replaceAll(":", "_");
    await this.queue.add("job", payload, jobId ? { jobId } : undefined);
  }

  async close() {
    await this.worker.close();
    await this.queue.close();
  }
}
