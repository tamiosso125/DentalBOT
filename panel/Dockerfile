# DentalBOT staff panel (Next.js standalone). Built from the repo root:
# docker build -f panel/Dockerfile -t dentalbot-panel .
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY panel/package.json panel/
RUN pnpm install --frozen-lockfile --filter @dentalbot/panel
COPY panel panel
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @dentalbot/panel build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3001 HOSTNAME=0.0.0.0
COPY --from=build /app/panel/.next/standalone ./
COPY --from=build /app/panel/.next/static panel/.next/static
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO /dev/null http://127.0.0.1:3001/login || exit 1
CMD ["node", "panel/server.js"]
