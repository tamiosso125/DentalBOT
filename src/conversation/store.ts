import { randomUUID } from "node:crypto";

export type ClinicInfo = { id: string; name: string };

export type ConversationRecord = {
  id: string;
  clinicId: string;
  /** Normalized wa_id (digits). Plain value only lives in memory; storage encrypts it. */
  contact: string;
  botPausedUntil: Date | null;
  privacyNoticeAt: Date | null;
  lastInboundAt: Date | null;
  marketingOptOutAt: Date | null;
};

export type ConversationPatch = Partial<
  Pick<
    ConversationRecord,
    "botPausedUntil" | "privacyNoticeAt" | "lastInboundAt" | "marketingOptOutAt"
  >
>;

export type MessageDirection = "INBOUND" | "OUTBOUND" | "ECHO";

export type NewMessage = {
  conversationId: string;
  waMessageId: string;
  direction: MessageDirection;
  type: string;
  body?: string;
};

/** Persistence port for conversations. Prisma in production, in-memory in tests/evals. */
export interface ConversationStore {
  findClinicByPhoneNumberId(phoneNumberId: string): Promise<ClinicInfo | null>;
  getOrCreateConversation(clinicId: string, contact: string): Promise<ConversationRecord>;
  hasMessage(waMessageId: string): Promise<boolean>;
  saveMessage(message: NewMessage): Promise<void>;
  updateConversation(id: string, patch: ConversationPatch): Promise<void>;
  updateMessageStatus(waMessageId: string, status: string): Promise<void>;
  createDataRequest(clinicId: string, conversationId: string): Promise<void>;
}

export class InMemoryConversationStore implements ConversationStore {
  readonly conversations = new Map<string, ConversationRecord>();
  readonly messages: Array<NewMessage & { status?: string }> = [];
  readonly dataRequests: Array<{ clinicId: string; conversationId: string }> = [];

  constructor(private readonly clinic: ClinicInfo & { phoneNumberId?: string }) {}

  async findClinicByPhoneNumberId(phoneNumberId: string) {
    if (this.clinic.phoneNumberId && this.clinic.phoneNumberId !== phoneNumberId) return null;
    return { id: this.clinic.id, name: this.clinic.name };
  }

  async getOrCreateConversation(clinicId: string, contact: string) {
    const key = `${clinicId}:${contact}`;
    let conv = this.conversations.get(key);
    if (!conv) {
      conv = {
        id: randomUUID(),
        clinicId,
        contact,
        botPausedUntil: null,
        privacyNoticeAt: null,
        lastInboundAt: null,
        marketingOptOutAt: null,
      };
      this.conversations.set(key, conv);
    }
    return { ...conv };
  }

  async hasMessage(waMessageId: string) {
    return this.messages.some((m) => m.waMessageId === waMessageId);
  }

  async saveMessage(message: NewMessage) {
    this.messages.push({ ...message });
  }

  async updateConversation(id: string, patch: ConversationPatch) {
    for (const conv of this.conversations.values()) {
      if (conv.id === id) Object.assign(conv, patch);
    }
  }

  async updateMessageStatus(waMessageId: string, status: string) {
    for (const m of this.messages) if (m.waMessageId === waMessageId) m.status = status;
  }

  async createDataRequest(clinicId: string, conversationId: string) {
    this.dataRequests.push({ clinicId, conversationId });
  }
}
