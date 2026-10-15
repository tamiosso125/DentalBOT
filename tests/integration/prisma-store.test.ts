import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaConversationStore } from "../../src/conversation/prisma-store.js";
import { FieldCipher } from "../../src/privacy/index.js";

// Runs only against a disposable database: TEST_DATABASE_URL=postgresql://... pnpm test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PrismaConversationStore (Postgres)", () => {
  const cipher = new FieldCipher(randomBytes(32).toString("base64"), "y".repeat(32));
  const phoneNumberId = `pnid_${Date.now()}`;
  let db: PrismaClient;
  let store: PrismaConversationStore;
  let clinicId = "";

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    store = new PrismaConversationStore(db, cipher);
    clinicId = (
      await db.clinic.create({
        data: { name: "Clínica Teste", whatsappPhoneNumberId: phoneNumberId },
      })
    ).id;
  });

  afterAll(async () => {
    await db.message.deleteMany({ where: { conversation: { clinicId } } });
    await db.dataSubjectRequest.deleteMany({ where: { clinicId } });
    await db.conversation.deleteMany({ where: { clinicId } });
    await db.clinic.delete({ where: { id: clinicId } });
    await db.$disconnect();
  });

  it("returns one conversation when a new number's messages arrive at the same time", async () => {
    const convs = await Promise.all(
      Array.from({ length: 8 }, () => store.getOrCreateConversation(clinicId, "5511900000009")),
    );
    expect(new Set(convs.map((c) => c.id)).size).toBe(1);
  });

  it("stores contacts and bodies encrypted, and dedupes messages", async () => {
    expect(await store.findClinicByPhoneNumberId(phoneNumberId)).toMatchObject({ id: clinicId });

    const conv = await store.getOrCreateConversation(clinicId, "5511900000001");
    const again = await store.getOrCreateConversation(clinicId, "5511900000001");
    expect(again.id).toBe(conv.id);

    const msg = {
      conversationId: conv.id,
      waMessageId: `wamid.${Date.now()}`,
      direction: "INBOUND" as const,
      type: "text",
      body: "oi",
    };
    await store.saveMessage(msg);
    await store.saveMessage(msg);
    expect(await store.hasMessage(msg.waMessageId)).toBe(true);

    const rows = await db.message.findMany({ where: { conversationId: conv.id } });
    expect(rows).toHaveLength(1);
    // Ciphertext is random base64, so compare whole values, not substrings.
    expect(rows[0]!.bodyEncrypted).not.toBe("oi");
    expect(cipher.decrypt(rows[0]!.bodyEncrypted!)).toBe("oi");

    const raw = await db.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(raw.contactEncrypted).not.toContain("5511900000001");
  });
});
