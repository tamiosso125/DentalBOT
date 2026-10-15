import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createLogger } from "./lib/logger.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const app = createApp(env, logger);

await app.server.listen({ port: env.PORT, host: "0.0.0.0" });
logger.info(
  { port: env.PORT, whatsapp: env.WHATSAPP_MODE, asaas: env.ASAAS_ENV, queue: env.QUEUE_MODE },
  "dentalbot up",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}
