/**
 * MCP server "dentalbot-agenda": the team's Claude Code looks at and changes the agenda
 * with the same rules as the WhatsApp attendant (see src/scheduling/agenda-mcp.ts).
 *
 * AGENDA_SOURCE=memory (default): fictitious demo clinic in memory, no database needed.
 * AGENDA_SOURCE=database: the local Postgres from .env (DATABASE_URL, PII_ENCRYPTION_KEY,
 * PII_HASH_SECRET, DEFAULT_CLINIC_ID). Refused with NODE_ENV=production: patient data
 * must not flow to a dev tool from the production database.
 */
import { PrismaClient } from "@prisma/client";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FieldCipher } from "../../src/privacy/index.js";
import { buildAgendaMcpServer } from "../../src/scheduling/agenda-mcp.js";
import { AgendaService } from "../../src/scheduling/agenda-service.js";
import { demoAgendaSeed, InMemoryAgendaRepository } from "../../src/scheduling/memory-agenda.js";
import { prismaAgendaFor } from "../../src/scheduling/prisma-agenda.js";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on the shell environment.
}

const source = process.env.AGENDA_SOURCE ?? "memory";

async function database() {
  if (process.env.NODE_ENV === "production")
    throw new Error("dentalbot-agenda does not run against production (NODE_ENV=production)");
  const { DATABASE_URL, PII_ENCRYPTION_KEY, PII_HASH_SECRET, DEFAULT_CLINIC_ID } = process.env;
  if (!DATABASE_URL || !PII_ENCRYPTION_KEY || !PII_HASH_SECRET || !DEFAULT_CLINIC_ID)
    throw new Error(
      "AGENDA_SOURCE=database needs DATABASE_URL, PII_ENCRYPTION_KEY, PII_HASH_SECRET and DEFAULT_CLINIC_ID",
    );
  const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const agenda = await prismaAgendaFor(
    db,
    new FieldCipher(PII_ENCRYPTION_KEY, PII_HASH_SECRET),
    DEFAULT_CLINIC_ID,
  );
  if (!agenda) throw new Error(`clinic ${DEFAULT_CLINIC_ID} not found (run pnpm db:seed)`);
  return agenda;
}

const agenda =
  source === "database"
    ? await database()
    : new AgendaService(new InMemoryAgendaRepository(demoAgendaSeed()));

await buildAgendaMcpServer(agenda).connect(new StdioServerTransport());
