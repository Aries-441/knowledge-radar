import { type Conversation, type FeedItem, type FeedSource, type Job, type Outbox, RuntimeStoreError, StorageBusyError, type Turn } from "./types.js";

export function conversationFromRow(row: Record<string, unknown>): Conversation {
  return {
    id: textValue(row, "id"),
    kind: textValue(row, "kind"),
    title: textValue(row, "title"),
    status: textValue(row, "status") as Conversation["status"],
    createdAt: numberValue(row, "created_at"),
    updatedAt: numberValue(row, "updated_at"),
  };
}

export function turnFromRow(row: Record<string, unknown>): Turn {
  return {
    id: textValue(row, "id"),
    conversationId: textValue(row, "conversation_id"),
    sequence: numberValue(row, "sequence"),
    source: textValue(row, "source"),
    content: textValue(row, "content"),
    state: textValue(row, "state") as Turn["state"],
    availableAt: numberValue(row, "available_at"),
    runToken: nullableTextValue(row, "run_token"),
    leaseExpiresAt: nullableNumberValue(row, "lease_expires_at"),
    attempts: numberValue(row, "attempts"),
    maxAttempts: numberValue(row, "max_attempts"),
    errorCode: nullableTextValue(row, "error_code"),
    createdAt: numberValue(row, "created_at"),
    updatedAt: numberValue(row, "updated_at"),
  };
}

export function jobFromRow(row: Record<string, unknown>): Job {
  return {
    id: textValue(row, "id"),
    originTurnId: nullableTextValue(row, "origin_turn_id"),
    kind: textValue(row, "kind"),
    payload: decodeJson(textValue(row, "payload_json"), "payload_json"),
    idempotencyKey: textValue(row, "idempotency_key"),
    result: row.result_json === null ? null : decodeJson(textValue(row, "result_json"), "result_json"),
    errorCode: nullableTextValue(row, "error_code"),
    state: textValue(row, "state") as Job["state"],
    availableAt: numberValue(row, "available_at"),
    runToken: nullableTextValue(row, "run_token"),
    leaseExpiresAt: nullableNumberValue(row, "lease_expires_at"),
    attempts: numberValue(row, "attempts"),
    maxAttempts: numberValue(row, "max_attempts"),
    createdAt: numberValue(row, "created_at"),
    updatedAt: numberValue(row, "updated_at"),
  };
}

export function feedSourceFromRow(row: Record<string, unknown>): FeedSource {
  let tags: unknown;
  try { tags = JSON.parse(textValue(row, "tags_json")); } catch { throw new RuntimeStoreError("Feed tags contain invalid JSON"); }
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== "string")) throw new RuntimeStoreError("Feed tags are invalid");
  let connectorConfig: unknown;
  try { connectorConfig = JSON.parse(textValue(row, "connector_config_json")); } catch { throw new RuntimeStoreError("Source connector config contains invalid JSON"); }
  if (!connectorConfig || typeof connectorConfig !== "object" || Array.isArray(connectorConfig)) throw new RuntimeStoreError("Source connector config is invalid");
  return {
    id: textValue(row, "id"),
    name: textValue(row, "display_name"),
    kind: textValue(row, "kind"),
    connectorConfig: connectorConfig as Record<string, unknown>,
    url: textValue(row, "url"),
    enabled: numberValue(row, "enabled") === 1,
    priority: numberValue(row, "priority"),
    tags,
    etag: nullableTextValue(row, "etag"),
    lastModified: nullableTextValue(row, "last_modified"),
    baselineAt: nullableNumberValue(row, "baseline_at"),
    lastCheckedAt: nullableNumberValue(row, "last_checked_at"),
    lastSuccessAt: nullableNumberValue(row, "last_success_at"),
    errorCode: nullableTextValue(row, "error_code"),
    createdAt: numberValue(row, "created_at"),
    updatedAt: numberValue(row, "updated_at"),
  };
}

export function feedItemFromRow(row: Record<string, unknown>): FeedItem {
  return {
    id: textValue(row, "id"),
    feedId: textValue(row, "feed_id"),
    identityKey: textValue(row, "identity_key"),
    canonicalUrl: nullableTextValue(row, "canonical_url"),
    title: textValue(row, "title"),
    summary: nullableTextValue(row, "summary"),
    author: nullableTextValue(row, "author"),
    publishedAt: nullableNumberValue(row, "published_at"),
    firstSeenAt: numberValue(row, "first_seen_at"),
    state: textValue(row, "state") as FeedItem["state"],
    notifiedAt: nullableNumberValue(row, "notified_at"),
    errorCode: nullableTextValue(row, "error_code"),
    createdAt: numberValue(row, "created_at"),
    updatedAt: numberValue(row, "updated_at"),
  };
}

export function outboxFromRow(row: Record<string, unknown>): Outbox {
  return {
    id: textValue(row, "id"),
    turnId: textValue(row, "turn_id"),
    kind: textValue(row, "kind"),
    payload: decodeJson(textValue(row, "payload_json"), "payload_json"),
    errorCode: nullableTextValue(row, "error_code"),
    state: textValue(row, "state") as Outbox["state"],
    availableAt: numberValue(row, "available_at"),
    runToken: nullableTextValue(row, "run_token"),
    leaseExpiresAt: nullableNumberValue(row, "lease_expires_at"),
    attempts: numberValue(row, "attempts"),
    maxAttempts: numberValue(row, "max_attempts"),
    createdAt: numberValue(row, "created_at"),
    updatedAt: numberValue(row, "updated_at"),
  };
}

export function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

export function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

export function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

export function requireTimestamp(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative epoch millisecond`);
  }
  return value;
}

export function encodeJson(value: unknown, name: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError(`${name} must be JSON serializable`);
  return encoded;
}

export function numberValue(row: Record<string, unknown> | undefined, name: string): number {
  const value = row?.[name];
  if (typeof value !== "number") throw new RuntimeStoreError(`Database column ${name} is not a number`);
  return value;
}

export function mapSqliteError(error: unknown): Error {
  if (error instanceof StorageBusyError || !/SQLITE_BUSY|database is locked/i.test(String(error))) {
    return error instanceof Error ? error : new RuntimeStoreError("Unknown SQLite error", { cause: error });
  }
  return new StorageBusyError(error);
}

function decodeJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new RuntimeStoreError(`${name} contains invalid JSON`);
  }
}

export function textValue(row: Record<string, unknown> | undefined, name: string): string {
  const value = row?.[name];
  if (typeof value !== "string") throw new RuntimeStoreError(`Database column ${name} is not text`);
  return value;
}

function nullableTextValue(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== "string") throw new RuntimeStoreError(`Database column ${name} is not nullable text`);
  return value;
}

function nullableNumberValue(row: Record<string, unknown>, name: string): number | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== "number") throw new RuntimeStoreError(`Database column ${name} is not nullable number`);
  return value;
}
