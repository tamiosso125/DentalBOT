import { Prisma, type PrismaClient } from "@prisma/client";
import { upsertRace } from "../lib/upsert-race.js";
import type { FieldCipher } from "../privacy/index.js";
import type {
  ClinicInfo,
  ConversationPatch,
  ConversationRecord,
  ConversationStore,
  NewMessage,
} from "./store.js";

export class PrismaConversationStore implements ConversationStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
    /** Single-clinic setup: used when the clinic has no phone_number_id configured yet. */
    private readonly defaultClinicId?: string,
  ) {}

  async findClinicByPhoneNumberId(phoneNumberId: string): Promise<ClinicInfo | null> {
    const clinic =
      (await this.db.clinic.findUnique({ where: { whatsappPhoneNumberId: phoneNumberId } })) ??
      (this.defaultClinicId
        ? await this.db.clinic.findUnique({ where: { id: this.defaultClinicId } })
        : null);
    return clinic ? { id: clinic.id, name: clinic.name } : null;
  }

  async getOrCreateConversation(clinicId: string, contact: string): Promise<ConversationRecord> {
    const contactHash = this.cipher.hash(contact);
    // A new number often sends a few messages at once, processed in parallel.
    const conv = await upsertRace(() =>
      this.db.conversation.upsert({
        where: { clinicId_contactHash: { clinicId, contactHash } },
        create: { clinicId, contactHash, contactEncrypted: this.cipher.encrypt(contact) },
        update: {},
      }),
    );
    return {
      id: conv.id,
      clinicId: conv.clinicId,
      contact,
      botPausedUntil: conv.botPausedUntil,
      privacyNoticeAt: conv.privacyNoticeAt,
      lastInboundAt: conv.lastInboundAt,
      marketingOptOutAt: conv.marketingOptOutAt,
      patientId: conv.patientId,
      agentState: conv.agentState,
    };
  }

  async hasMessage(waMessageId: string) {
    return (await this.db.message.count({ where: { waMessageId } })) > 0;
  }

  async saveMessage(m: NewMessage) {
    try {
      await this.db.message.create({
        data: {
          conversationId: m.conversationId,
          waMessageId: m.waMessageId,
          direction: m.direction,
          type: m.type,
          bodyEncrypted: m.body === undefined ? null : this.cipher.encrypt(m.body),
          ...(m.at ? { createdAt: m.at } : {}),
        },
      });
    } catch (err) {
      // Meta retries webhooks; a duplicate wamid means we already stored it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
      throw err;
    }
  }

  async updateConversation(id: string, patch: ConversationPatch) {
    const { agentState, ...rest } = patch;
    await this.db.conversation.update({
      where: { id },
      data: {
        ...rest,
        ...(agentState === undefined
          ? {}
          : {
              agentState:
                agentState === null ? Prisma.DbNull : (agentState as Prisma.InputJsonValue),
            }),
      },
    });
  }

  async updateMessageStatus(waMessageId: string, status: string) {
    await this.db.message.updateMany({ where: { waMessageId }, data: { status } });
  }

  async createDataRequest(clinicId: string, conversationId: string) {
    await this.db.dataSubjectRequest.create({ data: { clinicId, conversationId } });
  }

  async recentMessages(conversationId: string, since: Date, limit: number) {
    const rows = await this.db.message.findMany({
      where: { conversationId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { direction: true, bodyEncrypted: true, createdAt: true },
    });
    return rows.reverse().map((m) => ({
      direction: m.direction,
      body: m.bodyEncrypted === null ? null : this.cipher.decrypt(m.bodyEncrypted),
      at: m.createdAt,
    }));
  }

  async clinicProfile(clinicId: string) {
    const clinic = await this.db.clinic.findUnique({
      where: { id: clinicId },
      include: { insurancePlans: { select: { name: true }, orderBy: { name: "asc" } } },
    });
    if (!clinic) return null;
    return {
      name: clinic.name,
      address: clinic.address,
      insurancePlans: clinic.insurancePlans.map((p) => p.name),
    };
  }
}
