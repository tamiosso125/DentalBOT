import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // Linted by the root ESLint config (pnpm lint), like the rest of the repo.
  eslint: { ignoreDuringBuilds: true },
};

export default config;
