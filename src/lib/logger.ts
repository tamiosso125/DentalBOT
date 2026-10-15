import { pino, type Logger } from "pino";
import { redact } from "../privacy/index.js";

export type { Logger };

/**
 * Pino logger whose every object argument goes through redact().
 * Prefer logging ids (conversationId, waMessageId) over content.
 */
export function createLogger(level = "info"): Logger {
  return pino({
    level,
    hooks: {
      logMethod(args, method) {
        const safe = args.map((a) => redact(a)) as Parameters<typeof method>;
        method.apply(this, safe);
      },
    },
  });
}

export const silentLogger: Logger = pino({ level: "silent" });
