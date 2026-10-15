# DentalBOT API (Fastify). Built from the repo root: docker build -t dentalbot-api .
# Production stack and HTTPS: deploy/compose.yml (guide in docs/deploy-vps.md).
FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY panel/package.json panel/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter dentalbot
COPY tsconfig.json tsconfig.build.json ./
COPY prisma prisma
COPY src src
RUN pnpm db:generate && pnpm build

# Runtime dependencies only (the Prisma CLI is one: it applies migrations on start).
FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --filter dentalbot
COPY prisma prisma
RUN pnpm db:generate

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY prisma prisma
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]
