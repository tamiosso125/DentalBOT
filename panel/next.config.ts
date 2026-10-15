import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // Linted by the root ESLint config (pnpm lint), like the rest of the repo.
  eslint: { ignoreDuringBuilds: true },
  // Self-contained server for the Docker image (panel/Dockerfile). The tracing root is the
  // workspace, so dependencies hoisted by pnpm are found.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, ".."),
};

export default config;
