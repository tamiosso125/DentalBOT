import { randomUUID } from "node:crypto";

export type ClinicInfo = { id: string; name: string };

/** A procedure an insurance plan covers, as registered by the clinic. */
export type PlanCoverage = { plan: string; procedureId: string; requiresAuthorization: boolean };

/** Public clinic data the attendant may tell patients. */
export type ClinicProfile = {
  name: string;
  address: string | null;
  insurancePlans: string[];
  /** Covered procedures per plan. A plan with no rows has no coverage table registered yet. */
  coverage: PlanCoverage[];
};

export type ConversationRecord = {
  id: string;
  clinicId: string;
  /** Normalized wa_id (digits). Plain value only lives in memory; storage encrypts it. */
  contact: string;
  botPausedUntil: Date | null;
  privacyNoticeAt: Date | null;
  lastInboundAt: Date | null;
  marketingOptOutAt: Date | null;
  patientId: string | null;
  /** Orchestrator working memory (offered slots, numbered appointments). Never health data. */
  agentState: unknown;
};

export type ConversationPatch = Partial<
  Pick<
    ConversationRecord,
    | "botPausedUntil"
    | "privacyNoticeAt"
    | "lastInboundAt"
    | "marketingOptOutAt"
    | "patientId"
    | "agentState"
  >
>;

export type MessageDirection = "INBOUND" | "OUTBOUND" | "ECHO";

export type NewMessage = {
  conversationId: string;
  waMessageId: string;
  direction: MessageDirection;
  type: string;
  body?: string;
  at?: Date;
};

export type StoredMessage = { direction: MessageDirection; body: string | null; at: Date };

/** Persistence port for conversations. Prisma in production, in-memory in tests/evals. */
export interface ConversationStore {
  findClinicByPhoneNumberId(phoneNumberId: string): Promise<ClinicInfo | null>;
  getOrCreateConversation(clinicId: string, contact: string): Promise<ConversationRecord>;
  hasMessage(waMessageId: string): Promise<boolean>;
  saveMessage(message: NewMessage): Promise<void>;
  updateConversation(id: string, patch: ConversationPatch): Promise<void>;
  updateMessageStatus(waMessageId: string, status: string): Promise<void>;
  createDataRequest(clinicId: string, conversationId: string): Promise<void>;
  /** Decrypted messages since `since`, oldest first, at most `limit` (the most recent ones). */
  recentMessages(conversationId: string, since: Date, limit: number): Promise<StoredMessage[]>;
  clinicProfile(clinicId: string): Promise<ClinicProfile | null>;
}

export class InMemoryConversationStore implements ConversationStore {
  readonly conversations = new Map<string, ConversationRecord>();
  readonly messages: Array<NewMessage & { status?: string; at: Date }> = [];
  readonly dataRequests: Array<{ clinicId: string; conversationId: string }> = [];

  constructor(
    private readonly clinic: ClinicInfo & {
      phoneNumberId?: string;
      address?: string;
      insurancePlans?: string[];
      coverage?: PlanCoverage[];
    },
  ) {}

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
        patientId: null,
        agentState: null,
      };
      this.conversations.set(key, conv);
    }
    return { ...conv };
  }

  async hasMessage(waMessageId: string) {
    return this.messages.some((m) => m.waMessageId === waMessageId);
  }

  async saveMessage(message: NewMessage) {
    this.messages.push({ ...message, at: message.at ?? new Date() });
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

  async recentMessages(conversationId: string, since: Date, limit: number) {
    return this.messages
      .filter((m) => m.conversationId === conversationId && m.at >= since)
      .slice(-limit)
      .map((m) => ({ direction: m.direction, body: m.body ?? null, at: m.at }));
  }

  async clinicProfile(clinicId: string) {
    if (clinicId !== this.clinic.id) return null;
    return {
      name: this.clinic.name,
      address: this.clinic.address ?? null,
      insurancePlans: this.clinic.insurancePlans ?? [],
      coverage: this.clinic.coverage ?? [],
    };
  }
}
