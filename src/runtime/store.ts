import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { classifyCaptureRequest } from "../article/request.js";
import { validateCheckpoint, displayTitle, type CaptureCheckpoint } from "../article/durable-archive.js";
import { captureFailureText, captureReasons, type CaptureErrorCode } from "../article/capture-error.js";
import { normalizeSourceConfig, type FeedSourceConfig } from "../feed/config.js";
import type { SourceConfig } from "../feed/source.js";
import type { ParsedFeed } from "../feed/parser.js";
import { buildFeedDigest, type DigestCandidate, type DigestPayload } from "../feed/digest.js";
import type { CaptureContext } from "./types.js";

import {
  conversationFromRow,
  encodeJson,
  feedItemFromRow,
  feedSourceFromRow,
  jobFromRow,
  mapSqliteError,
  numberValue,
  outboxFromRow,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireText,
  requireTimestamp,
  textValue,
  turnFromRow,
} from "./serialization.js";
import { migrateRuntimeSchema } from "./schema.js";
import {
  RuntimeStoreError,
  type Conversation,
  type CompletedTurn,
  type FeedItem,
  type FeedSource,
  type CreateConversationInput,
  type CreateTurnInput,
  type EnqueueJobInput,
  type EnqueueOutboxInput,
  type Job,
  type Outbox,
  type RuntimeStoreOptions,
  type Turn,
  type FeishuScope,
  type FeishuText,
  type FeishuAcceptance,
  type DigestFeedbackResult,
  type DigestFeedbackState,
  type DigestMessage,
} from "./types.js";

function sourceIdFromPollPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.sourceId === "string") return record.sourceId;
  if (typeof record.feedId === "string") return record.feedId;
  return null;
}

function digestMessageFromRow(row: Record<string, unknown>): DigestMessage {
  let itemIds: unknown;
  try { itemIds = JSON.parse(textValue(row, "item_ids_json")); } catch { throw new RuntimeStoreError("digest_message_item_ids_invalid"); }
  if (!Array.isArray(itemIds) || itemIds.some(itemId => typeof itemId !== "string" || !itemId)) {
    throw new RuntimeStoreError("digest_message_item_ids_invalid");
  }
  return {
    appId: textValue(row, "app_id"),
    tenantKey: textValue(row, "tenant_key"),
    ownerOpenId: textValue(row, "owner_open_id"),
    messageId: textValue(row, "message_id"),
    card: textValue(row, "card_json"),
    itemIds,
    createdAt: numberValue(row, "created_at"),
  };
}

export { RuntimeStoreError, StorageBusyError } from "./types.js";
export type {
  Conversation,
  CreateConversationInput,
  CreateTurnInput,
  EnqueueJobInput,
  EnqueueOutboxInput,
  FeedItem,
  FeedSource,
  Job,
  Outbox,
  RuntimeStoreOptions,
  Turn,
  DigestFeedbackResult,
  DigestFeedbackState,
  DigestMessage,
} from "./types.js";

const DEFAULT_BUSY_TIMEOUT_MS = 250;
const DIGEST_SCOPE_SQL = `json_extract(payload_json, '$.scope.appId') = ?
  AND json_extract(payload_json, '$.scope.tenantKey') = ?
  AND json_extract(payload_json, '$.scope.ownerOpenId') = ?`;

const FEISHU_TURNS_SQL = `
  SELECT i.turn_id FROM feishu_inbound_messages i
  JOIN feishu_chats c ON c.app_id = i.app_id AND c.tenant_key = i.tenant_key AND c.chat_id = i.chat_id
  JOIN turns t ON t.id = i.turn_id AND t.conversation_id = c.conversation_id
  WHERE c.app_id = ? AND c.tenant_key = ? AND c.owner_open_id = ?
`;
const CAPTURE_TURNS_SQL = FEISHU_TURNS_SQL + " AND t.source = 'feishu_url_capture'";
const CAPTURE_JOBS_SQL = `kind = 'capture_article' AND origin_turn_id IN (${CAPTURE_TURNS_SQL})`;
const FEISHU_OUTBOX_SQL = `outbox.turn_id IN (${FEISHU_TURNS_SQL}) AND (
  outbox.kind = 'final_message' OR (outbox.kind = 'job_result' AND EXISTS (
    SELECT 1 FROM jobs j JOIN turns t ON t.id = j.origin_turn_id
    WHERE j.origin_turn_id = outbox.turn_id AND j.kind = 'capture_article'
      AND t.source = 'feishu_url_capture' AND j.state IN ('succeeded', 'failed')
  )))`;

type Queue = {
  table: "turns" | "jobs" | "outbox";
  activeState: "running" | "sending";
  retryState: "queued" | "pending";
};

const TURN_QUEUE: Queue = { table: "turns", activeState: "running", retryState: "queued" };
const JOB_QUEUE: Queue = { table: "jobs", activeState: "running", retryState: "pending" };
const OUTBOX_QUEUE: Queue = { table: "outbox", activeState: "sending", retryState: "pending" };

export function openRuntimeStore(options: RuntimeStoreOptions): RuntimeStore {
  const path = requireText(options.path, "path");
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  requireNonNegativeInteger(busyTimeoutMs, "busyTimeoutMs");

  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  const store = new RuntimeStore(database, options.now ?? Date.now, options.createToken ?? randomUUID);

  try {
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    store.migrate();
    return store;
  } catch (error) {
    database.close();
    throw mapSqliteError(error);
  }
}

export class RuntimeStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => number,
    private readonly createToken: () => string,
  ) {}

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  createConversation(input: CreateConversationInput): Conversation {
    const now = this.currentTime();
    const id = input.id ?? this.newId();
    const kind = requireText(input.kind, "kind");
    const title = requireText(input.title, "title");

    return this.transaction(() => {
      this.database
        .prepare(
          "INSERT INTO conversations (id, kind, title, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
        )
        .run(id, kind, title, now, now);
      return this.getConversationRequired(id);
    });
  }

  createTurn(input: CreateTurnInput): Turn {
    const now = this.currentTime();
    const id = input.id ?? this.newId();
    const conversationId = requireText(input.conversationId, "conversationId");
    const source = requireText(input.source, "source");
    const content = requireText(input.content, "content");
    const maxAttempts = requirePositiveInteger(input.maxAttempts, "maxAttempts");
    const availableAt = input.availableAt ?? now;
    requireTimestamp(availableAt, "availableAt");

    return this.transaction(() => {
      const row = this.database
        .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM turns WHERE conversation_id = ?")
        .get(conversationId);
      const sequence = numberValue(row, "next_sequence");
      this.database
        .prepare(
          `INSERT INTO turns (
            id, conversation_id, sequence, source, content, state, available_at,
            run_token, lease_expires_at, attempts, max_attempts, error_code, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, 0, ?, NULL, ?, ?)`,
        )
        .run(id, conversationId, sequence, source, content, availableAt, maxAttempts, now, now);
      return this.getTurnRequired(id);
    });
  }

  enqueueJob(input: EnqueueJobInput): Job {
    const now = this.currentTime();
    const id = input.id ?? this.newId();
    const originTurnId = input.originTurnId === undefined ? null : requireText(input.originTurnId, "originTurnId");
    const kind = requireText(input.kind, "kind");
    const idempotencyKey = requireText(input.idempotencyKey, "idempotencyKey");
    const payload = encodeJson(input.payload, "payload");
    const maxAttempts = requirePositiveInteger(input.maxAttempts, "maxAttempts");
    const availableAt = input.availableAt ?? now;
    requireTimestamp(availableAt, "availableAt");

    return this.transaction(() => {
      const existing = this.getJobByIdempotencyKey(idempotencyKey);
      if (existing) return existing;

      this.database
        .prepare(
          `INSERT INTO jobs (
            id, origin_turn_id, kind, payload_json, idempotency_key, result_json, error_code, state,
            available_at, run_token, lease_expires_at, attempts, max_attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'pending', ?, NULL, NULL, 0, ?, ?, ?)`,
        )
        .run(id, originTurnId, kind, payload, idempotencyKey, availableAt, maxAttempts, now, now);
      return this.getJobRequired(id);
    });
  }

  enqueueOutbox(input: EnqueueOutboxInput): Outbox {
    const now = this.currentTime();
    const id = input.id ?? this.newId();
    const turnId = requireText(input.turnId, "turnId");
    const kind = requireText(input.kind, "kind");
    const payload = encodeJson(input.payload, "payload");
    const maxAttempts = requirePositiveInteger(input.maxAttempts, "maxAttempts");
    const availableAt = input.availableAt ?? now;
    requireTimestamp(availableAt, "availableAt");

    return this.transaction(() => {
      const existing = this.getOutboxByTurnAndKind(turnId, kind);
      if (existing) return existing;

      this.insertOutbox(id, turnId, kind, payload, maxAttempts, availableAt, now);
      return this.getOutboxRequired(id);
    });
  }

  claimTurn(conversationId: string, leaseMs: number): Turn | null {
    return this.transaction(() => {
      const now = this.currentTime();
      const leaseExpiresAt = this.leaseDeadline(now, leaseMs);
      const candidate = this.database
        .prepare(
          `SELECT id FROM turns
           WHERE conversation_id = ?
             AND state NOT IN ('answered', 'failed')
           ORDER BY sequence
           LIMIT 1`,
        )
        .get(requireText(conversationId, "conversationId"));
      if (!candidate) return null;

      const id = textValue(candidate, "id");
      const token = this.newToken();
      const changed = this.database
        .prepare(
          `UPDATE turns
           SET state = 'running', attempts = attempts + 1, run_token = ?, lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND state = 'queued' AND available_at <= ? AND attempts < max_attempts`,
        )
        .run(token, leaseExpiresAt, now, id, now).changes;
      return changed === 1 ? this.getTurnRequired(id) : null;
    });
  }

  claimJob(leaseMs: number, kind?: string, scope?: FeishuScope): Job | null {
    return this.transaction(() => {
      const now = this.currentTime();
      const leaseExpiresAt = this.leaseDeadline(now, leaseMs);
      const jobKind = kind === undefined ? undefined : requireText(kind, "kind");
      const candidate = this.database
        .prepare(
          `SELECT id FROM jobs
           WHERE state = 'pending' AND available_at <= ? AND attempts < max_attempts
             ${jobKind === undefined ? "" : "AND kind = ?"}
             ${scope ? `AND ${DIGEST_SCOPE_SQL}` : ""}
           ORDER BY available_at, created_at, id
           LIMIT 1`,
        )
        .get(...(jobKind === undefined ? [now] : [now, jobKind]), ...(scope ? this.feishuScopeParams(scope) : []));
      if (!candidate) return null;

      const id = textValue(candidate, "id");
      const token = this.newToken();
      const changed = this.database
        .prepare(
          `UPDATE jobs
           SET state = 'running', attempts = attempts + 1, run_token = ?, lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND state = 'pending' AND available_at <= ? AND attempts < max_attempts`,
        )
        .run(token, leaseExpiresAt, now, id, now).changes;
      return changed === 1 ? this.getJobRequired(id) : null;
    });
  }

  syncSources(sources: Array<FeedSourceConfig | SourceConfig>): FeedSource[] {
    const now = this.currentTime();
    return this.transaction(() => {
      const ids = new Set<string>();
      for (const configured of sources) {
        const feed = normalizeSourceConfig(configured);
        const id = requireText(feed.id, "source.id");
        const name = requireText(feed.name, "source.name");
        const url = requireText(feed.url, "source.url");
        const tags = encodeJson(feed.tags, "source.tags");
        const connectorConfig = encodeJson(feed.connectorConfig, "source.connectorConfig");
        ids.add(id);
        const existing = this.database.prepare("SELECT url, kind, connector_config_json FROM feed_sources WHERE id = ?").get(id);
        const changed = existing && (textValue(existing, "url") !== url
          || textValue(existing, "kind") !== feed.kind
          || textValue(existing, "connector_config_json") !== connectorConfig);
        if (changed) {
          this.database.prepare("DELETE FROM feed_items WHERE feed_id = ?").run(id);
          this.database.prepare(
            `UPDATE feed_sources SET display_name = ?, kind = ?, connector_config_json = ?, url = ?, enabled = ?, priority = ?, tags_json = ?,
             etag = NULL, last_modified = NULL, baseline_at = NULL, last_checked_at = NULL,
             last_success_at = NULL, error_code = NULL, updated_at = ? WHERE id = ?`,
          ).run(name, feed.kind, connectorConfig, url, feed.enabled ? 1 : 0, feed.priority, tags, now, id);
        } else {
          this.database.prepare(
            `INSERT INTO feed_sources
              (id, display_name, kind, connector_config_json, url, enabled, priority, tags_json, etag, last_modified, baseline_at,
               last_checked_at, last_success_at, error_code, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
             ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
               kind = excluded.kind, connector_config_json = excluded.connector_config_json,
               url = excluded.url, enabled = excluded.enabled, priority = excluded.priority,
               tags_json = excluded.tags_json, updated_at = excluded.updated_at`,
          ).run(id, name, feed.kind, connectorConfig, url, feed.enabled ? 1 : 0, feed.priority, tags, now, now);
        }
      }
      if (ids.size === 0) {
        this.database.prepare("UPDATE feed_sources SET enabled = 0, updated_at = ?").run(now);
      } else {
        const placeholders = [...ids].map(() => "?").join(", ");
        this.database.prepare(
          `UPDATE feed_sources SET enabled = 0, updated_at = ? WHERE id NOT IN (${placeholders})`,
        ).run(now, ...ids);
      }
      return this.listFeedSourcesInternal(false);
    });
  }

  syncFeedSources(feeds: FeedSourceConfig[]): FeedSource[] {
    return this.syncSources(feeds);
  }

  listSources(enabledOnly = false): FeedSource[] {
    try { return this.listFeedSourcesInternal(enabledOnly); } catch (error) { throw mapSqliteError(error); }
  }

  listFeedSources(enabledOnly = false): FeedSource[] {
    return this.listSources(enabledOnly);
  }

  getSource(id: string): FeedSource | null {
    try {
      const row = this.database.prepare("SELECT * FROM feed_sources WHERE id = ?").get(requireText(id, "id"));
      return row ? feedSourceFromRow(row) : null;
    } catch (error) { throw mapSqliteError(error); }
  }

  getFeedSource(id: string): FeedSource | null {
    return this.getSource(id);
  }

  listFeedItems(feedId?: string): FeedItem[] {
    try {
      const rows = feedId === undefined
        ? this.database.prepare("SELECT * FROM feed_items ORDER BY first_seen_at, id").iterate()
        : this.database.prepare("SELECT * FROM feed_items WHERE feed_id = ? ORDER BY first_seen_at, id").iterate(requireText(feedId, "feedId"));
      return [...rows].map(row => feedItemFromRow(row));
    } catch (error) { throw mapSqliteError(error); }
  }

  ensureFeedPollJobs(intervalMs: number, maxAttempts = 3): Job[] {
    requirePositiveInteger(intervalMs, "intervalMs");
    requirePositiveInteger(maxAttempts, "maxAttempts");
    return this.transaction(() => {
      const now = this.currentTime();
      const created: Job[] = [];
      const rows = this.database.prepare("SELECT * FROM feed_sources WHERE enabled = 1 ORDER BY priority, id").iterate();
      for (const row of rows) {
        const source = feedSourceFromRow(row);
        if (source.lastCheckedAt !== null && now - source.lastCheckedAt < intervalMs) continue;
        const active = this.database.prepare(
          `SELECT 1 FROM jobs WHERE kind = 'feed_poll' AND state IN ('pending', 'running')
             AND (json_extract(payload_json, '$.sourceId') = ? OR json_extract(payload_json, '$.feedId') = ?) LIMIT 1`,
        ).get(source.id, source.id);
        if (active) continue;
        const idempotencyKey = `feed_poll:${source.id}:${Math.floor(now / intervalMs)}`;
        if (this.getJobByIdempotencyKey(idempotencyKey)) continue;
        const id = this.newId();
        this.database.prepare(
          `INSERT INTO jobs (id, origin_turn_id, kind, payload_json, idempotency_key, result_json, error_code,
             state, available_at, run_token, lease_expires_at, attempts, max_attempts, created_at, updated_at)
           VALUES (?, NULL, 'feed_poll', ?, ?, NULL, NULL, 'pending', ?, NULL, NULL, 0, ?, ?, ?)`,
        ).run(id, encodeJson({ version: 2, sourceId: source.id, feedId: source.id }, "payload"), idempotencyKey, now, maxAttempts, now, now);
        created.push(this.getJobRequired(id));
      }
      return created;
    });
  }

  recoverFeedPollJobs(): number {
    return this.transaction(() => {
      const now = this.currentTime();
      return Number(this.database.prepare(
        `UPDATE jobs SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
           available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE ? END,
           error_code = CASE WHEN attempts >= max_attempts THEN error_code ELSE 'lease_expired' END,
           run_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE kind = 'feed_poll' AND state = 'running' AND lease_expires_at <= ?`,
      ).run(now, now, now).changes);
    });
  }

  commitFeedPoll(jobId: string, runToken: string, parsed: ParsedFeed): { feedId: string; baseline: boolean; newItems: number; totalItems: number } | null {
    return this.transaction(() => {
      const now = this.currentTime();
      const job = this.getJobById(requireText(jobId, "jobId"));
      if (!job || job.kind !== "feed_poll" || job.state !== "running" || job.runToken !== requireText(runToken, "runToken") || job.leaseExpiresAt === null || job.leaseExpiresAt <= now) return null;
      const payload = job.payload;
      const feedId = sourceIdFromPollPayload(payload);
      if (!feedId) throw new RuntimeStoreError("feed_poll job payload is invalid");
      const source = this.getFeedSourceById(feedId);
      if (!source) throw new RuntimeStoreError(`Feed source disappeared: ${feedId}`);
      const baseline = source.baselineAt === null;
      let newItems = 0;
      if (!parsed.notModified) {
        for (const item of parsed.items) {
          const existing = this.database.prepare("SELECT id FROM feed_items WHERE feed_id = ? AND identity_key = ?").get(feedId, item.identityKey);
          if (!existing) newItems++;
          const itemId = existing ? textValue(existing, "id") : this.newId();
          this.database.prepare(
            `INSERT INTO feed_items
              (id, feed_id, identity_key, canonical_url, title, summary, author, published_at, first_seen_at,
               state, error_code, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
             ON CONFLICT(feed_id, identity_key) DO UPDATE SET canonical_url = excluded.canonical_url,
               title = excluded.title, summary = excluded.summary, author = excluded.author,
               published_at = excluded.published_at, error_code = NULL, updated_at = excluded.updated_at`,
          ).run(itemId, feedId, item.identityKey, item.canonicalUrl, item.title, item.summary || null, item.author,
            item.publishedAt, now, baseline ? "baseline" : "candidate", now, now);
        }
      }
      const baselineAt = baseline && !parsed.notModified ? now : source.baselineAt;
      this.database.prepare(
        `UPDATE feed_sources SET etag = ?, last_modified = ?, baseline_at = ?, last_checked_at = ?,
           last_success_at = ?, error_code = NULL, updated_at = ? WHERE id = ?`,
      ).run(parsed.etag, parsed.lastModified, baselineAt, now, now, now, feedId);
      const result = { feedId, baseline, newItems, totalItems: parsed.items.length };
      const changed = this.database.prepare(
        `UPDATE jobs SET state = 'succeeded', result_json = ?, error_code = NULL,
           run_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'running' AND run_token = ? AND lease_expires_at > ?`,
      ).run(encodeJson(result, "result"), now, jobId, runToken, now).changes;
      return changed === 1 ? result : null;
    });
  }

  recordFeedPollFailure(jobId: string, runToken: string, errorCode: string, retryable: boolean, retryAt: number): boolean {
    requireTimestamp(retryAt, "retryAt");
    return this.transaction(() => {
      const now = this.currentTime();
      const job = this.getJobById(requireText(jobId, "jobId"));
      if (!job || job.kind !== "feed_poll" || job.state !== "running" || job.runToken !== requireText(runToken, "runToken") || job.leaseExpiresAt === null || job.leaseExpiresAt <= now) return false;
      const payload = job.payload;
      const feedId = sourceIdFromPollPayload(payload);
      if (feedId) this.database.prepare("UPDATE feed_sources SET last_checked_at = ?, error_code = ?, updated_at = ? WHERE id = ?").run(now, errorCode, now, feedId);
      const nextState = retryable && job.attempts < job.maxAttempts ? "pending" : "failed";
      const changed = this.database.prepare(
        `UPDATE jobs SET state = ?, available_at = ?, error_code = ?, run_token = NULL,
           lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'running' AND run_token = ? AND lease_expires_at > ?`,
      ).run(nextState, nextState === "pending" ? retryAt : job.availableAt, errorCode, now, jobId, runToken, now).changes;
      return changed === 1;
    });
  }

  listFeedDigestCandidates(scope: FeishuScope): DigestCandidate[] {
    // ponytail: bounded single-user subscriptions; add a URL delivery index if history makes this scan expensive.
    return this.database.prepare(`
      SELECT i.*, s.display_name AS source_name, s.priority FROM feed_items i
      JOIN feed_sources s ON s.id = i.feed_id
      WHERE i.state = 'candidate' AND i.notified_at IS NULL AND s.enabled = 1
        AND NOT EXISTS (
          SELECT 1 FROM jobs, json_each(payload_json, '$.canonicalUrls') link
          WHERE kind = 'feed_digest' AND state = 'succeeded' AND ${DIGEST_SCOPE_SQL}
            AND link.value = i.canonical_url
        )
    `).all(...this.feishuScopeParams(scope)).map(row => ({ ...feedItemFromRow(row),
      sourceName: textValue(row, "source_name"), priority: numberValue(row, "priority") }));
  }

  listDigestFeedbackStates(scope: FeishuScope, itemIds?: string[]): Map<string, boolean> {
    const params = this.feishuScopeParams(scope);
    const ids = itemIds?.map(id => requireText(id, "itemId"));
    const filter = ids && ids.length > 0 ? ` AND feed_item_id IN (${ids.map(() => "?").join(", ")})` : "";
    try {
      const rows = this.database.prepare(`
        SELECT feed_item_id, interested FROM digest_feedback
        WHERE app_id = ? AND tenant_key = ? AND owner_open_id = ?${filter}
      `).all(...params, ...(ids ?? []));
      return new Map(rows.map(row => [textValue(row, "feed_item_id"), numberValue(row, "interested") === 1]));
    } catch (error) { throw mapSqliteError(error); }
  }

  recordDigestMessage(scope: FeishuScope, messageId: string, card: string, itemIds: string[]): DigestMessage {
    const [appId, tenantKey, ownerOpenId] = this.feishuScopeParams(scope);
    const id = requireText(messageId, "messageId");
    const content = requireText(card, "card");
    if (Buffer.byteLength(content, "utf8") > 20_000) throw new RangeError("card exceeds Feishu payload limit");
    const ids = itemIds.map(itemId => requireText(itemId, "itemId"));
    if (ids.length === 0 || ids.length > 50) throw new RangeError("itemIds must contain between 1 and 50 items");
    const itemIdsJson = encodeJson([...new Set(ids)], "itemIds");
    return this.transaction(() => this.recordDigestMessageInternal(
      appId, tenantKey, ownerOpenId, id, content, itemIdsJson,
    ));
  }

  getDigestMessage(scope: FeishuScope, messageId: string): DigestMessage | null {
    const [appId, tenantKey, ownerOpenId] = this.feishuScopeParams(scope);
    try {
      const row = this.database.prepare(`
        SELECT * FROM digest_messages
        WHERE message_id = ? AND app_id = ? AND tenant_key = ? AND owner_open_id = ?
      `).get(requireText(messageId, "messageId"), appId, tenantKey, ownerOpenId);
      return row ? digestMessageFromRow(row) : null;
    } catch (error) { throw mapSqliteError(error); }
  }

  applyDigestFeedback({
    scope, eventId, messageId, feedItemId, targetInterested,
  }: {
    scope: FeishuScope;
    eventId: string;
    messageId: string;
    feedItemId: string;
    targetInterested: boolean;
  }): DigestFeedbackResult {
    const [appId, tenantKey, ownerOpenId] = this.feishuScopeParams(scope);
    const id = requireText(eventId, "eventId");
    const message = requireText(messageId, "messageId");
    const itemId = requireText(feedItemId, "feedItemId");
    if (typeof targetInterested !== "boolean") throw new TypeError("targetInterested must be boolean");
    return this.transaction(() => {
      const digestMessage = this.getDigestMessageById(message);
      if (!digestMessage || digestMessage.appId !== appId || digestMessage.tenantKey !== tenantKey || digestMessage.ownerOpenId !== ownerOpenId) {
        throw new RuntimeStoreError("digest_feedback_message_not_found");
      }
      if (!digestMessage.itemIds.includes(itemId)) throw new RuntimeStoreError("digest_feedback_item_not_in_message");
      if (!this.database.prepare("SELECT 1 FROM feed_items WHERE id = ?").get(itemId)) {
        throw new RuntimeStoreError("digest_feedback_item_not_found");
      }

      const previousEvent = this.database.prepare("SELECT * FROM digest_feedback_events WHERE event_id = ?").get(id);
      if (previousEvent) {
        if (textValue(previousEvent, "app_id") !== appId || textValue(previousEvent, "tenant_key") !== tenantKey
          || textValue(previousEvent, "owner_open_id") !== ownerOpenId || textValue(previousEvent, "message_id") !== message
          || textValue(previousEvent, "feed_item_id") !== itemId || numberValue(previousEvent, "target_interested") !== (targetInterested ? 1 : 0)) {
          throw new RuntimeStoreError("digest_feedback_event_conflict");
        }
        const current = this.database.prepare(`
          SELECT interested FROM digest_feedback
          WHERE app_id = ? AND tenant_key = ? AND owner_open_id = ? AND feed_item_id = ?
        `).get(appId, tenantKey, ownerOpenId, itemId);
        return { outcome: "duplicate", interested: current ? numberValue(current, "interested") === 1 : targetInterested };
      }

      const now = this.currentTime();
      this.database.prepare(`
        INSERT INTO digest_feedback_events
          (event_id, app_id, tenant_key, owner_open_id, message_id, feed_item_id, target_interested, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, appId, tenantKey, ownerOpenId, message, itemId, targetInterested ? 1 : 0, now);
      this.database.prepare(`
        INSERT INTO digest_feedback
          (app_id, tenant_key, owner_open_id, feed_item_id, interested, last_message_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (app_id, tenant_key, owner_open_id, feed_item_id) DO UPDATE SET
          interested = excluded.interested,
          last_message_id = excluded.last_message_id,
          updated_at = excluded.updated_at
      `).run(appId, tenantKey, ownerOpenId, itemId, targetInterested ? 1 : 0, message, now);
      return { outcome: "applied", interested: targetInterested };
    });
  }

  ensureFeedDigestJob(scope: FeishuScope, date: string, maxItems: number): Job | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50) {
      throw new TypeError("Invalid digest configuration");
    }
    const scopeParams = this.feishuScopeParams(scope);
    const scopeKey = createHash("sha256").update(JSON.stringify(scopeParams)).digest("hex");
    const key = `feed_digest:${scopeKey}:${date}`;
    return this.transaction(() => {
      if (this.getJobByIdempotencyKey(key)) return null;
      // Freeze and finish one delivery before preparing another day's batch.
      if (this.database.prepare(`SELECT 1 FROM jobs WHERE kind = 'feed_digest'
          AND state IN ('pending', 'running') AND ${DIGEST_SCOPE_SQL} LIMIT 1`).get(...scopeParams)) return null;
      const candidates = this.listFeedDigestCandidates(scope);
      const digest = buildFeedDigest(candidates, date, maxItems, this.listDigestFeedbackStates(scope, candidates.map(item => item.id)));
      if (!digest) return null;
      const id = this.newId(), now = this.currentTime();
      const payload: DigestPayload = { version: 2, scope: { appId: scope.appId, tenantKey: scope.tenantKey,
        ownerOpenId: scope.ownerOpenId }, date, ...digest };
      this.database.prepare(`INSERT INTO jobs (id, origin_turn_id, kind, payload_json, idempotency_key,
        result_json, error_code, state, available_at, run_token, lease_expires_at, attempts, max_attempts, created_at, updated_at)
        VALUES (?, NULL, 'feed_digest', ?, ?, NULL, NULL, 'pending', ?, NULL, NULL, 0, 3, ?, ?)`)
        .run(id, encodeJson(payload, "payload"), key, now, now, now);
      return this.getJobRequired(id);
    });
  }

  recoverFeedDigestJobs(scope: FeishuScope): number {
    return this.transaction(() => {
      const now = this.currentTime();
      return Number(this.database.prepare(`UPDATE jobs SET
        state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
        available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE ? END,
        error_code = 'lease_expired', run_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE kind = 'feed_digest' AND state = 'running' AND lease_expires_at <= ? AND ${DIGEST_SCOPE_SQL}`)
        .run(now, now, now, ...this.feishuScopeParams(scope)).changes);
    });
  }

  commitFeedDigest(jobId: string, runToken: string, scope: FeishuScope, messageId: string, card?: string): boolean {
    requireText(messageId, "messageId");
    return this.transaction(() => {
      const now = this.currentTime();
      const row = this.database.prepare(`SELECT * FROM jobs WHERE id = ? AND kind = 'feed_digest'
        AND state = 'running' AND run_token = ? AND lease_expires_at > ? AND ${DIGEST_SCOPE_SQL}`)
        .get(jobId, runToken, now, ...this.feishuScopeParams(scope));
      if (!row) return false;
      const payload = jobFromRow(row).payload as DigestPayload;
      if (card) {
        const itemIdsJson = encodeJson(payload.itemIds, "itemIds");
        this.recordDigestMessageInternal(scope.appId, scope.tenantKey, scope.ownerOpenId,
          requireText(messageId, "messageId"), card, itemIdsJson);
      }
      for (const id of payload.itemIds) {
        this.database.prepare("UPDATE feed_items SET notified_at = ?, updated_at = ? WHERE id = ? AND state = 'candidate' AND notified_at IS NULL")
          .run(now, now, id);
      }
      this.database.prepare(`UPDATE jobs SET state = 'succeeded', result_json = ?, error_code = NULL,
        run_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(encodeJson({ messageId }, "result"), now, jobId);
      return true;
    });
  }

  claimOutbox(leaseMs: number, scope?: FeishuScope): Outbox | null {
    const scopeParams = scope ? this.feishuScopeParams(scope) : [];
    return this.transaction(() => {
      const now = this.currentTime();
      const leaseExpiresAt = this.leaseDeadline(now, leaseMs);
      const candidate = this.database
        .prepare(
          `SELECT outbox.id
           FROM outbox
           JOIN turns ON turns.id = outbox.turn_id
           WHERE outbox.state = 'pending'
             ${scope ? `AND ${FEISHU_OUTBOX_SQL}` : ""}
             AND outbox.available_at <= ?
             AND outbox.attempts < outbox.max_attempts
             AND (${scope ? "outbox.kind != 'final_message' OR " : ""}NOT EXISTS (
               SELECT 1
               FROM outbox earlier_outbox
               JOIN turns earlier_turn ON earlier_turn.id = earlier_outbox.turn_id
               WHERE earlier_turn.conversation_id = turns.conversation_id
                 AND earlier_turn.sequence < turns.sequence
                 AND earlier_outbox.state NOT IN ('sent', 'failed')
                 ${scope ? "AND earlier_outbox.kind = 'final_message'" : ""}
             ))
             ${scope ? `AND (outbox.kind != 'job_result' OR EXISTS (
               SELECT 1 FROM outbox ack WHERE ack.turn_id = outbox.turn_id
                 AND ack.kind = 'final_message' AND ack.state IN ('sent', 'failed')
             ))` : ""}
           ORDER BY ${scope ? "outbox.available_at, outbox.created_at, outbox.id" : "turns.conversation_id, turns.sequence, outbox.created_at"}
           LIMIT 1`,
        )
        .get(...scopeParams, now);
      if (!candidate) return null;

      const id = textValue(candidate, "id");
      const token = this.newToken();
      const changed = this.database
        .prepare(
          `UPDATE outbox
           SET state = 'sending', attempts = attempts + 1, run_token = ?, lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND state = 'pending' AND available_at <= ? AND attempts < max_attempts`,
        )
        .run(token, leaseExpiresAt, now, id, now).changes;
      return changed === 1 ? this.getOutboxRequired(id) : null;
    });
  }

  renewTurn(id: string, runToken: string, leaseMs: number): boolean {
    return this.renew(TURN_QUEUE, id, runToken, leaseMs);
  }

  acceptFeishuText(input: FeishuText): FeishuAcceptance {
    const [appId, tenantKey, owner] = this.feishuScopeParams(input);
    const chatId = requireText(input.chatId, "chatId");
    const messageId = requireText(input.messageId, "messageId");
    const content = requireText(input.text, "text");
    return this.transaction(() => {
      const now = this.currentTime();
      const existing = this.database.prepare(`
        SELECT i.turn_id, i.chat_id, c.conversation_id, c.owner_open_id
        FROM feishu_inbound_messages i JOIN feishu_chats c
          ON c.app_id = i.app_id AND c.tenant_key = i.tenant_key AND c.chat_id = i.chat_id
        WHERE i.app_id = ? AND i.tenant_key = ? AND i.message_id = ?
      `).get(appId, tenantKey, messageId);
      if (existing) {
        if (existing.chat_id !== chatId || existing.owner_open_id !== owner) {
          return { outcome: "ignored", reason: "identity_conflict" };
        }
        return { outcome: "duplicate", conversationId: textValue(existing, "conversation_id"),
          turnId: textValue(existing, "turn_id") };
      }
      const chat = this.database.prepare(`
        SELECT c.conversation_id, c.owner_open_id, v.status
        FROM feishu_chats c JOIN conversations v ON v.id = c.conversation_id
        WHERE c.app_id = ? AND c.tenant_key = ? AND c.chat_id = ?
      `).get(appId, tenantKey, chatId);
      if (chat && chat.owner_open_id !== owner) return { outcome: "ignored", reason: "identity_conflict" };
      if (chat && chat.status !== "active") return { outcome: "ignored", reason: "conversation_archived" };
      const conversationId = chat ? textValue(chat, "conversation_id") : this.newId();
      if (!chat) {
        this.database.prepare(`
          INSERT INTO conversations VALUES (?, 'feishu_private', '飞书私聊', 'active', ?, ?)
        `).run(conversationId, now, now);
        this.database.prepare("INSERT INTO feishu_chats VALUES (?, ?, ?, ?, ?, ?)")
          .run(appId, tenantKey, chatId, owner, conversationId, now);
      }
      const turnId = this.newId();
      const sequence = numberValue(this.database.prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM turns WHERE conversation_id = ?"
      ).get(conversationId), "n");
      this.database.prepare(`
        INSERT INTO turns (id, conversation_id, sequence, source, content, state, available_at,
          run_token, lease_expires_at, attempts, max_attempts, error_code, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, 0, 3, NULL, ?, ?)
      `).run(turnId, conversationId, sequence, classifyCaptureRequest(content).kind === "chat" ? "feishu" : "feishu_url_capture", content, now, now, now);
      this.database.prepare("INSERT INTO feishu_inbound_messages VALUES (?, ?, ?, ?, ?, ?)")
        .run(appId, tenantKey, messageId, chatId, turnId, now);
      return { outcome: "accepted", conversationId, turnId };
    });
  }

  listFeishuConversations(scope: FeishuScope): string[] {
    try {
      return this.database.prepare(`
        SELECT c.conversation_id FROM feishu_chats c
        JOIN conversations v ON v.id = c.conversation_id
        WHERE c.app_id = ? AND c.tenant_key = ? AND c.owner_open_id = ? AND v.status = 'active'
        ORDER BY c.created_at, c.conversation_id
      `).all(...this.feishuScopeParams(scope)).map(row => textValue(row, "conversation_id"));
    } catch (error) { throw mapSqliteError(error); }
  }

  getHeadTurn(conversationId: string): Turn | null {
    try {
      const row = this.database.prepare(`
        SELECT * FROM turns WHERE conversation_id = ? AND state NOT IN ('answered', 'failed')
        ORDER BY sequence LIMIT 1
      `).get(requireText(conversationId, "conversationId"));
      return row ? turnFromRow(row) : null;
    } catch (error) { throw mapSqliteError(error); }
  }

  getFeishuReplyTarget(turnId: string, scope: FeishuScope): string | null {
    try {
      const row = this.database.prepare(`
        SELECT message_id FROM feishu_inbound_messages
        WHERE turn_id = ? AND turn_id IN (${FEISHU_TURNS_SQL})
      `).get(requireText(turnId, "turnId"), ...this.feishuScopeParams(scope));
      return row ? textValue(row, "message_id") : null;
    } catch (error) { throw mapSqliteError(error); }
  }

  recoverFeishuOutbox(scope: FeishuScope): { id: string; state: string }[] {
    return this.transaction(() => {
      const now = this.currentTime();
      return this.database.prepare(`
        UPDATE outbox
        SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
            available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE ? END,
            error_code = 'lease_expired', run_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE state = 'sending' AND lease_expires_at <= ? AND ${FEISHU_OUTBOX_SQL}
        RETURNING id, state
      `).all(now, now, now, ...this.feishuScopeParams(scope))
        .map(row => ({ id: textValue(row, "id"), state: textValue(row, "state") }));
    });
  }

  private feishuScopeParams(scope: FeishuScope): [string, string, string] {
    return [requireText(scope.appId, "appId"), requireText(scope.tenantKey, "tenantKey"),
      requireText(scope.ownerOpenId, "ownerOpenId")];
  }

  acceptCaptureTurn(turnId: string, token: string, scope: FeishuScope, available: boolean): Job | Outbox | null {
    return this.transaction(() => {
      const now = this.currentTime();
      const row = this.database.prepare(`SELECT * FROM turns WHERE id = ? AND state = 'running'
        AND run_token = ? AND lease_expires_at > ? AND id IN (${CAPTURE_TURNS_SQL})`)
        .get(turnId, token, now, ...this.feishuScopeParams(scope));
      if (!row) return null;
      const request = classifyCaptureRequest(textValue(row, "content"));
      let job: Job | null = null;
      let text: string;
      if (request.kind !== "capture" || !available) {
        text = captureReasons[request.kind === "reject" ? request.code : request.kind === "chat" ? "capture_invalid_request" : "capture_unavailable"];
      } else {
        const key = `capture_article:${turnId}`;
        const payload = { version: 1, url: request.url };
        job = this.getJobByIdempotencyKey(key);
        if (job && (job.originTurnId !== turnId || job.kind !== "capture_article"
          || (job.payload as { version?: unknown })?.version !== 1
          || (job.payload as { url?: unknown })?.url !== request.url)) throw new RuntimeStoreError("capture_idempotency_conflict");
        if (!job) {
          const id = this.newId();
          this.database.prepare(`INSERT INTO jobs (id, origin_turn_id, kind, payload_json, idempotency_key,
            state, available_at, attempts, max_attempts, created_at, updated_at)
            VALUES (?, ?, 'capture_article', ?, ?, 'pending', ?, 0, 3, ?, ?)`)
            .run(id, turnId, encodeJson(payload, "payload"), key, now, now, now);
          job = this.getJobRequired(id);
        }
        text = "已接收，正在采集。";
      }
      this.database.prepare(`UPDATE turns SET state = 'answered', run_token = NULL, lease_expires_at = NULL,
        error_code = NULL, updated_at = ? WHERE id = ?`).run(now, turnId);
      const id = this.newId();
      this.insertOutbox(id, turnId, "final_message", JSON.stringify({ text }), 3, now, now);
      return job ?? this.getOutboxRequired(id);
    });
  }

  backfillCaptureRejections(scope: FeishuScope): number {
    return this.transaction(() => {
      const rows = this.database.prepare(`SELECT id FROM turns WHERE state = 'failed' AND id IN (${CAPTURE_TURNS_SQL})
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE origin_turn_id = turns.id)
        AND NOT EXISTS (SELECT 1 FROM outbox WHERE turn_id = turns.id AND kind = 'final_message')
        ORDER BY created_at, id LIMIT 20`).all(...this.feishuScopeParams(scope));
      const now = this.currentTime();
      for (const row of rows) this.insertOutbox(this.newId(), textValue(row, "id"), "final_message",
        JSON.stringify({ text: "采集请求未能完成受理，请重新发送链接。" }), 3, now, now);
      return rows.length;
    });
  }

  claimCaptureJob(scope: FeishuScope): Job | null {
    return this.transaction(() => {
      const now = this.currentTime();
      const row = this.database.prepare(`SELECT id FROM jobs WHERE ${CAPTURE_JOBS_SQL}
        AND state = 'pending' AND available_at <= ? AND attempts < max_attempts
        ORDER BY available_at, created_at, id LIMIT 1`).get(...this.feishuScopeParams(scope), now);
      if (!row) return null;
      const id = textValue(row, "id");
      this.database.prepare(`UPDATE jobs SET state = 'running', attempts = attempts + 1,
        run_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
        .run(this.newToken(), now + 120_000, now, id);
      return this.getJobRequired(id);
    });
  }

  private activeCaptureJob(id: string, token: string, scope: FeishuScope): Job | null {
    const row = this.database.prepare(`SELECT * FROM jobs WHERE id = ? AND run_token = ?
      AND state = 'running' AND lease_expires_at > ? AND ${CAPTURE_JOBS_SQL}`)
      .get(id, token, this.currentTime(), ...this.feishuScopeParams(scope));
    return row ? jobFromRow(row) : null;
  }

  readCaptureCheckpoint(id: string, token: string, scope: FeishuScope): { checkpoint: CaptureCheckpoint | null } | null {
    return this.transaction(() => this.activeCaptureJob(id, token, scope) ? { checkpoint: this.checkpointByJob(id) } : null);
  }

  saveCaptureCheckpoint(id: string, token: string, scope: FeishuScope, checkpoint: CaptureCheckpoint): CaptureCheckpoint | null {
    return this.transaction(() => {
      const job = this.activeCaptureJob(id, token, scope);
      if (!job) return null;
      const existing = this.checkpointByJob(id);
      if (existing) return existing;
      const validated = validateCheckpoint(id, checkpoint);
      if ((job.payload as { url?: string })?.url !== validated.requestedUrl
        || validated.taskCreatedAt !== new Date(job.createdAt).toISOString()) throw new RuntimeStoreError("capture_checkpoint_mismatch");
      this.database.prepare("INSERT INTO article_captures VALUES (?, ?)").run(id, JSON.stringify(validated));
      return validated;
    });
  }

  private checkpointByJob(id: string): CaptureCheckpoint | null {
    const row = this.database.prepare("SELECT result_json FROM article_captures WHERE job_id = ?").get(id);
    return row ? validateCheckpoint(id, JSON.parse(textValue(row, "result_json"))) : null;
  }

  completeCaptureJob(id: string, token: string, scope: FeishuScope): boolean {
    return this.transaction(() => {
      const job = this.activeCaptureJob(id, token, scope);
      if (!job) return false;
      const checkpoint = this.checkpointByJob(id);
      if (!checkpoint) throw new RuntimeStoreError("capture_checkpoint_missing");
      const now = this.currentTime();
      this.database.prepare(`UPDATE jobs SET state = 'succeeded', result_json = ?, error_code = NULL,
        run_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify({ version: 1, checkpointId: id, filename: checkpoint.filename }), now, id);
      this.insertOutbox(this.newId(), job.originTurnId!, "job_result", JSON.stringify({ text: checkpoint.replyText }), 3, now, now);
      return true;
    });
  }

  retryCaptureJob(id: string, token: string, scope: FeishuScope, error: CaptureErrorCode, permanent: boolean,
    retryAfterMs = 0): "lost_lease" | "failed" | "retry_scheduled" {
    return this.transaction(() => {
      const job = this.activeCaptureJob(id, token, scope);
      if (!job) return "lost_lease";
      if (permanent || job.attempts >= job.maxAttempts) {
        this.failCaptureJobWithResult(job, error);
        return "failed";
      }
      const now = this.currentTime();
      const requested = Math.max(30_000, retryAfterMs);
      const available = Number.isSafeInteger(now + requested) ? now + requested : now + 30_000;
      this.database.prepare(`UPDATE jobs SET state = 'pending', error_code = ?, available_at = ?,
        run_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`).run(error, available, now, id);
      return "retry_scheduled";
    });
  }

  private failCaptureJobWithResult(job: Job, error: CaptureErrorCode): void {
    const now = this.currentTime();
    const exists = Boolean(this.database.prepare("SELECT 1 FROM article_captures WHERE job_id = ?").get(job.id));
    this.database.prepare(`UPDATE jobs SET state = 'failed', error_code = ?, run_token = NULL,
      lease_expires_at = NULL, updated_at = ? WHERE id = ?`).run(error, now, job.id);
    this.insertOutbox(this.newId(), job.originTurnId!, "job_result",
      JSON.stringify({ text: captureFailureText(job.id, error, exists) }), 3, now, now);
  }

  recoverCaptureJobs(scope: FeishuScope): { id: string; state: string }[] {
    return this.transaction(() => {
      const now = this.currentTime();
      const rows = this.database.prepare(`SELECT * FROM jobs WHERE ${CAPTURE_JOBS_SQL}
        AND state = 'running' AND lease_expires_at <= ? ORDER BY created_at, id`)
        .all(...this.feishuScopeParams(scope), now);
      return rows.map(row => {
        const job = jobFromRow(row);
        if (job.attempts >= job.maxAttempts) this.failCaptureJobWithResult(job, "capture_interrupted");
        else this.database.prepare(`UPDATE jobs SET state = 'pending', run_token = NULL, lease_expires_at = NULL,
          error_code = 'lease_expired', available_at = ?, updated_at = ? WHERE id = ?`).run(now, now, job.id);
        return { id: job.id, state: job.attempts >= job.maxAttempts ? "failed" : "pending" };
      });
    });
  }

  getFeishuContext(conversationId: string, beforeSequence: number, scope: FeishuScope): { history: CompletedTurn[]; captureContext: CaptureContext } {
    return this.transaction(() => {
      const captureContext: CaptureContext = { results: [], statuses: [] };
      if (!this.database.prepare(`SELECT 1 FROM feishu_chats WHERE conversation_id = ?
        AND app_id = ? AND tenant_key = ? AND owner_open_id = ?`).get(conversationId, ...this.feishuScopeParams(scope))) {
        return { history: [], captureContext };
      }
      const history = this.getCompletedHistory(conversationId, beforeSequence);
      const rows = this.database.prepare(`SELECT j.*, t.sequence, a.result_json AS checkpoint,
        o.created_at AS result_created, o.id AS result_id, o.payload_json AS result_payload
        FROM jobs j JOIN turns t ON t.id = j.origin_turn_id
        LEFT JOIN article_captures a ON a.job_id = j.id
        LEFT JOIN outbox o ON o.turn_id = t.id AND o.kind = 'job_result'
        WHERE j.kind = 'capture_article' AND j.origin_turn_id IN (${CAPTURE_TURNS_SQL})
          AND t.conversation_id = ? AND t.sequence < ? ORDER BY o.created_at DESC, o.id DESC`)
        .all(...this.feishuScopeParams(scope), conversationId, beforeSequence);
      for (const row of rows) {
        const jobId = textValue(row, "id"), originSequence = numberValue(row, "sequence");
        if (row.state === "succeeded" && row.checkpoint && row.result_id && captureContext.results.length < 3) {
          try {
            const cp = validateCheckpoint(jobId, JSON.parse(textValue(row, "checkpoint")));
            if (JSON.parse(textValue(row, "result_payload"))?.text !== cp.replyText) continue;
            const item = { jobId, originSequence, title: displayTitle(cp.title), summary: cp.summary, keyPoints: cp.keyPoints, filename: cp.filename };
            if (JSON.stringify(item).length <= 4_000) captureContext.results.push(item);
          } catch { /* Invalid legacy/manual data is not knowledge. */ }
        } else if (["pending", "running", "failed"].includes(String(row.state))) {
          const state = row.state as "pending" | "running" | "failed";
          const item = { jobId, originSequence, state, ...(state === "failed" ? { error: captureReasons[row.error_code as CaptureErrorCode] ?? "任务失败。" } : {}) };
          if (JSON.stringify(item).length <= 500) captureContext.statuses.push(item);
        }
      }
      captureContext.results.reverse();
      captureContext.statuses = captureContext.statuses.sort((a, b) => b.originSequence - a.originSequence).slice(0, 3).reverse();
      while (JSON.stringify(captureContext).length > 12_000) {
        if (captureContext.results.length) captureContext.results.shift(); else captureContext.statuses.shift();
      }
      return { history, captureContext };
    }, false);
  }

  renewJob(id: string, runToken: string, leaseMs: number): boolean {
    return this.renew(JOB_QUEUE, id, runToken, leaseMs);
  }

  renewOutbox(id: string, runToken: string, leaseMs: number): boolean {
    return this.renew(OUTBOX_QUEUE, id, runToken, leaseMs);
  }

  failTurn(id: string, runToken: string, errorCode: string): boolean {
    return this.fail(TURN_QUEUE, id, runToken, errorCode);
  }

  failJob(id: string, runToken: string, errorCode: string): boolean {
    return this.fail(JOB_QUEUE, id, runToken, errorCode);
  }

  failOutbox(id: string, runToken: string, errorCode: string): boolean {
    return this.fail(OUTBOX_QUEUE, id, runToken, errorCode);
  }

  retryTurn(id: string, runToken: string, availableAt: number, errorCode: string): boolean {
    return this.retry(TURN_QUEUE, id, runToken, availableAt, errorCode);
  }

  retryJob(id: string, runToken: string, availableAt: number, errorCode: string): boolean {
    return this.retry(JOB_QUEUE, id, runToken, availableAt, errorCode);
  }

  retryOutbox(id: string, runToken: string, availableAt: number, errorCode: string): boolean {
    return this.retry(OUTBOX_QUEUE, id, runToken, availableAt, errorCode);
  }

  completeTurnWithOutbox(
    turnId: string,
    runToken: string,
    input: Omit<EnqueueOutboxInput, "turnId">,
  ): Outbox | null {
    const id = input.id ?? this.newId();
    const kind = requireText(input.kind, "kind");
    const payload = encodeJson(input.payload, "payload");
    const maxAttempts = requirePositiveInteger(input.maxAttempts, "maxAttempts");

    return this.transaction(() => {
      const now = this.currentTime();
      const availableAt = input.availableAt ?? now;
      requireTimestamp(availableAt, "availableAt");
      const changed = this.database
        .prepare(
          `UPDATE turns
           SET state = 'answered', run_token = NULL, lease_expires_at = NULL, error_code = NULL, updated_at = ?
           WHERE id = ? AND state = 'running' AND run_token = ? AND lease_expires_at > ?`,
        )
        .run(now, requireText(turnId, "turnId"), requireText(runToken, "runToken"), now).changes;
      if (changed !== 1) return null;

      const existing = this.getOutboxByTurnAndKind(turnId, kind);
      if (existing) return existing;
      this.insertOutbox(id, turnId, kind, payload, maxAttempts, availableAt, now);
      return this.getOutboxRequired(id);
    });
  }

  completeJob(id: string, runToken: string, result: unknown): boolean {
    return this.transaction(() => {
      const now = this.currentTime();
      const changed = this.database
        .prepare(
          `UPDATE jobs
           SET state = 'succeeded', result_json = ?, error_code = NULL, run_token = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'running' AND run_token = ? AND lease_expires_at > ?`,
        )
        .run(encodeJson(result, "result"), now, requireText(id, "id"), requireText(runToken, "runToken"), now).changes;
      return changed === 1;
    });
  }

  markOutboxSent(id: string, runToken: string): boolean {
    return this.transaction(() => {
      const now = this.currentTime();
      const changed = this.database
        .prepare(
          `UPDATE outbox
           SET state = 'sent', error_code = NULL, run_token = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'sending' AND run_token = ? AND lease_expires_at > ?`,
        )
        .run(now, requireText(id, "id"), requireText(runToken, "runToken"), now).changes;
      return changed === 1;
    });
  }

  recoverExpiredLeases(): { turns: number; jobs: number; outbox: number } {
    return this.transaction(() => {
      const now = this.currentTime();
      return {
        turns: this.recover(TURN_QUEUE, now),
        jobs: this.recover(JOB_QUEUE, now),
        outbox: this.recover(OUTBOX_QUEUE, now),
      };
    });
  }

  recoverExpiredTurns(conversationId: string): number {
    requireText(conversationId, "conversationId");
    return this.transaction(() => this.recover(TURN_QUEUE, this.currentTime(), conversationId));
  }

  getCompletedHistory(conversationId: string, beforeSequence: number): CompletedTurn[] {
    requireText(conversationId, "conversationId");
    requirePositiveInteger(beforeSequence, "beforeSequence");
    try {
      const history: CompletedTurn[] = [];
      const rows = this.database.prepare(`
        SELECT turns.content, outbox.payload_json
        FROM turns JOIN outbox ON outbox.turn_id = turns.id
        WHERE turns.conversation_id = ? AND turns.sequence < ?
          AND turns.state = 'answered' AND outbox.kind = 'final_message'
        ORDER BY turns.sequence DESC
      `).iterate(conversationId, beforeSequence);
      for (const row of rows) {
        let payload: unknown;
        try { payload = JSON.parse(textValue(row, "payload_json")); } catch { continue; }
        if (!payload || typeof payload !== "object" || !("text" in payload) || typeof payload.text !== "string") continue;
        const content = textValue(row, "content");
        if (content.length + payload.text.length > 4_000) continue;
        history.push({ content, text: payload.text });
        if (history.length === 6) break;
      }
      return history.reverse();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  getConversation(id: string): Conversation | null {
    try {
      return this.getConversationById(requireText(id, "id"));
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  getTurn(id: string): Turn | null {
    try { return this.getTurnById(requireText(id, "id")); } catch (error) { throw mapSqliteError(error); }
  }

  getJob(id: string): Job | null {
    try { return this.getJobById(requireText(id, "id")); } catch (error) { throw mapSqliteError(error); }
  }

  getOutbox(id: string): Outbox | null {
    try { return this.getOutboxById(requireText(id, "id")); } catch (error) { throw mapSqliteError(error); }
  }

  migrate(): void {
    migrateRuntimeSchema(this.database, (operation) => this.transaction(operation));
  }

  private renew(queue: Queue, id: string, runToken: string, leaseMs: number): boolean {
    return this.transaction(() => {
      const now = this.currentTime();
      const changed = this.database
        .prepare(
          `UPDATE ${queue.table}
           SET lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND state = ? AND run_token = ? AND lease_expires_at > ?`,
        )
        .run(
          this.leaseDeadline(now, leaseMs),
          now,
          requireText(id, "id"),
          queue.activeState,
          requireText(runToken, "runToken"),
          now,
        ).changes;
      return changed === 1;
    });
  }

  private fail(queue: Queue, id: string, runToken: string, errorCode: string): boolean {
    return this.transaction(() => {
      const now = this.currentTime();
      const changed = this.database
        .prepare(
          `UPDATE ${queue.table}
           SET state = 'failed', error_code = ?, run_token = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND state = ? AND run_token = ? AND lease_expires_at > ?`,
        )
        .run(
          requireText(errorCode, "errorCode"),
          now,
          requireText(id, "id"),
          queue.activeState,
          requireText(runToken, "runToken"),
          now,
        ).changes;
      return changed === 1;
    });
  }

  private retry(queue: Queue, id: string, runToken: string, availableAt: number, errorCode: string): boolean {
    requireTimestamp(availableAt, "availableAt");

    return this.transaction(() => {
      const now = this.currentTime();
      if (availableAt <= now) throw new RangeError("availableAt must be in the future for a retry");
      const changed = this.database
        .prepare(
          `UPDATE ${queue.table}
           SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE ? END,
               available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE ? END,
               error_code = ?,
               run_token = NULL,
               lease_expires_at = NULL,
               updated_at = ?
           WHERE id = ? AND state = ? AND run_token = ? AND lease_expires_at > ?`,
        )
        .run(
          queue.retryState,
          availableAt,
          requireText(errorCode, "errorCode"),
          now,
          requireText(id, "id"),
          queue.activeState,
          requireText(runToken, "runToken"),
          now,
        ).changes;
      return changed === 1;
    });
  }

  private recover(queue: Queue, now: number, conversationId?: string): number {
    const result = this.database
      .prepare(
        `UPDATE ${queue.table}
         SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE ? END,
             available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE ? END,
             error_code = CASE WHEN attempts >= max_attempts THEN error_code ELSE 'lease_expired' END,
             run_token = NULL,
             lease_expires_at = NULL,
             updated_at = ?
          WHERE state = ? AND lease_expires_at <= ?${conversationId === undefined ? "" : " AND conversation_id = ?"}`,
      )
      .run(queue.retryState, now, now, queue.activeState, now, ...(conversationId === undefined ? [] : [conversationId]));
    return Number(result.changes);
  }

  private insertOutbox(
    id: string,
    turnId: string,
    kind: string,
    payload: string,
    maxAttempts: number,
    availableAt: number,
    now: number,
  ): void {
    this.database
      .prepare(
        `INSERT INTO outbox (
          id, turn_id, kind, payload_json, error_code, state, available_at,
          run_token, lease_expires_at, attempts, max_attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, 'pending', ?, NULL, NULL, 0, ?, ?, ?)`,
      )
      .run(id, turnId, kind, payload, availableAt, maxAttempts, now, now);
  }

  private getConversationById(id: string): Conversation | null {
    const row = this.database.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
    return row ? conversationFromRow(row) : null;
  }

  private getTurnById(id: string): Turn | null {
    const row = this.database.prepare("SELECT * FROM turns WHERE id = ?").get(id);
    return row ? turnFromRow(row) : null;
  }

  private getJobById(id: string): Job | null {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? jobFromRow(row) : null;
  }

  private getJobByIdempotencyKey(idempotencyKey: string): Job | null {
    const row = this.database.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(idempotencyKey);
    return row ? jobFromRow(row) : null;
  }

  private getDigestMessageById(messageId: string): DigestMessage | null {
    const row = this.database.prepare("SELECT * FROM digest_messages WHERE message_id = ?").get(messageId);
    return row ? digestMessageFromRow(row) : null;
  }

  private recordDigestMessageInternal(
    appId: string, tenantKey: string, ownerOpenId: string, messageId: string, card: string, itemIdsJson: string,
  ): DigestMessage {
    const existing = this.getDigestMessageById(messageId);
    if (existing) {
      if (existing.appId !== appId || existing.tenantKey !== tenantKey || existing.ownerOpenId !== ownerOpenId
        || existing.card !== card || JSON.stringify(existing.itemIds) !== itemIdsJson) {
        throw new RuntimeStoreError("digest_message_conflict");
      }
      return existing;
    }
    const now = this.currentTime();
    this.database.prepare(`
      INSERT INTO digest_messages
        (message_id, app_id, tenant_key, owner_open_id, card_json, item_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(messageId, appId, tenantKey, ownerOpenId, card, itemIdsJson, now);
    return this.getDigestMessageRequired(messageId);
  }

  private getDigestMessageRequired(messageId: string): DigestMessage {
    const message = this.getDigestMessageById(messageId);
    if (!message) throw new RuntimeStoreError(`Digest message disappeared: ${messageId}`);
    return message;
  }

  private listFeedSourcesInternal(enabledOnly: boolean): FeedSource[] {
    const rows = this.database.prepare(
      `SELECT * FROM feed_sources ${enabledOnly ? "WHERE enabled = 1" : ""} ORDER BY priority, id`,
    ).iterate();
    return [...rows].map(row => feedSourceFromRow(row));
  }

  private getFeedSourceById(id: string): FeedSource | null {
    const row = this.database.prepare("SELECT * FROM feed_sources WHERE id = ?").get(id);
    return row ? feedSourceFromRow(row) : null;
  }

  private getOutboxById(id: string): Outbox | null {
    const row = this.database.prepare("SELECT * FROM outbox WHERE id = ?").get(id);
    return row ? outboxFromRow(row) : null;
  }

  private getOutboxByTurnAndKind(turnId: string, kind: string): Outbox | null {
    const row = this.database.prepare("SELECT * FROM outbox WHERE turn_id = ? AND kind = ?").get(turnId, kind);
    return row ? outboxFromRow(row) : null;
  }

  private getConversationRequired(id: string): Conversation {
    const conversation = this.getConversationById(id);
    if (!conversation) throw new RuntimeStoreError(`Conversation disappeared: ${id}`);
    return conversation;
  }

  private getTurnRequired(id: string): Turn {
    const turn = this.getTurnById(id);
    if (!turn) throw new RuntimeStoreError(`Turn disappeared: ${id}`);
    return turn;
  }

  private getJobRequired(id: string): Job {
    const job = this.getJobById(id);
    if (!job) throw new RuntimeStoreError(`Job disappeared: ${id}`);
    return job;
  }

  private getOutboxRequired(id: string): Outbox {
    const outbox = this.getOutboxById(id);
    if (!outbox) throw new RuntimeStoreError(`Outbox disappeared: ${id}`);
    return outbox;
  }

  private transaction<T>(operation: () => T, write = true): T {
    let started = false;
    try {
      this.database.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
      started = true;
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (started) this.database.exec("ROLLBACK");
      throw mapSqliteError(error);
    }
  }

  private currentTime(): number {
    return requireTimestamp(this.now(), "clock result");
  }

  private newId(): string {
    return requireText(randomUUID(), "generated id");
  }

  private newToken(): string {
    return requireText(this.createToken(), "generated run token");
  }

  private leaseDeadline(now: number, leaseMs: number): number {
    return now + requirePositiveInteger(leaseMs, "leaseMs");
  }
}
