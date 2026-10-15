import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": src(""), "server-only": src("test/server-only.ts") },
  },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
