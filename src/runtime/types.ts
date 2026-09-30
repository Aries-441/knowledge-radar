export type Conversation = {
  id: string;
  kind: string;
  title: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
};

export type CompletedTurn = { content: string; text: string };
export type CaptureContext = {
  results: { jobId: string; originSequence: number; title: string; summary: string; keyPoints: string[]; filename: string }[];
  statuses: { jobId: string; originSequence: number; state: "pending" | "running" | "failed"; error?: string }[];
};

export type FeishuScope = { appId: string; tenantKey: string; ownerOpenId: string };
export type FeishuText = FeishuScope & { chatId: string; messageId: string; text: string };
export type DigestMessage = FeishuScope & {
  messageId: string;
  card: string;
  itemIds: string[];
  createdAt: number;
};
export type DigestFeedbackState = FeishuScope & {
  feedItemId: string;
  interested: boolean;
  lastMessageId: string;
  updatedAt: number;
};
export type DigestFeedbackResult = {
  outcome: "applied" | "duplicate";
  interested: boolean;
};
export type FeishuAcceptance =
  | { outcome: "accepted" | "duplicate"; conversationId: string; turnId: string }
  | { outcome: "ignored"; reason: "identity_conflict" | "conversation_archived" };

export type Turn = {
  id: string;
  conversationId: string;
  sequence: number;
  source: string;
  content: string;
  state: "queued" | "running" | "answered" | "failed";
  availableAt: number;
  runToken: string | null;
  leaseExpiresAt: number | null;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
};

export type Job = {
  id: string;
  originTurnId: string | null;
  kind: string;
  payload: unknown;
  idempotencyKey: string;
  result: unknown | null;
  errorCode: string | null;
  state: "pending" | "running" | "succeeded" | "failed";
  availableAt: number;
  runToken: string | null;
  leaseExpiresAt: number | null;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
};

export type FeedSource = {
  id: string;
  name: string;
  kind: string;
  connectorConfig: Record<string, unknown>;
  url: string;
  enabled: boolean;
  priority: number;
  tags: string[];
  etag: string | null;
  lastModified: string | null;
  baselineAt: number | null;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
};

export type FeedItemMetadata = Record<string, string | number | boolean | null>;

export type FeedItem = {
  id: string;
  feedId: string;
  identityKey: string;
  canonicalUrl: string | null;
  title: string;
  summary: string | null;
  author: string | null;
  publishedAt: number | null;
  metadata?: FeedItemMetadata;
  firstSeenAt: number;
  state: "baseline" | "candidate";
  notifiedAt: number | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
};

export type Outbox = {
  id: string;
  turnId: string;
  kind: string;
  payload: unknown;
  errorCode: string | null;
  state: "pending" | "sending" | "sent" | "failed";
  availableAt: number;
  runToken: string | null;
  leaseExpiresAt: number | null;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
};

export type RuntimeStoreOptions = {
  path: string;
  now?: () => number;
  createToken?: () => string;
  busyTimeoutMs?: number;
};

export type CreateConversationInput = {
  id?: string;
  kind: string;
  title: string;
};

export type CreateTurnInput = {
  id?: string;
  conversationId: string;
  source: string;
  content: string;
  maxAttempts: number;
  availableAt?: number;
};

export type EnqueueJobInput = {
  id?: string;
  originTurnId?: string;
  kind: string;
  payload: unknown;
  idempotencyKey: string;
  maxAttempts: number;
  availableAt?: number;
};

export type EnqueueOutboxInput = {
  id?: string;
  turnId: string;
  kind: string;
  payload: unknown;
  maxAttempts: number;
  availableAt?: number;
};

export class RuntimeStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeStoreError";
  }
}

export class StorageBusyError extends RuntimeStoreError {
  constructor(cause: unknown) {
    super("SQLite state store is busy; retry the operation", { cause });
    this.name = "StorageBusyError";
  }
}
