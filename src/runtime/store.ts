import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { classifyCaptureRequest } from "../article/request.js";
import { validateCheckpoint, displayTitle, type CaptureCheckpoint } from "../article/durable-archive.js";
import { captureFailureText, captureReasons, type CaptureErrorCode } from "../article/capture-error.js";
import type { CaptureContext } from "./types.js";

import {
  conversationFromRow,
  encodeJson,
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
} from "./types.js";

export { RuntimeStoreError, StorageBusyError } from "./types.js";
export type {
  Conversation,
  CreateConversationInput,
  CreateTurnInput,
  EnqueueJobInput,
  EnqueueOutboxInput,
  Job,
  Outbox,
  RuntimeStoreOptions,
  Turn,
} from "./types.js";

const DEFAULT_BUSY_TIMEOUT_MS = 250;

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

  claimJob(leaseMs: number): Job | null {
    return this.transaction(() => {
      const now = this.currentTime();
      const leaseExpiresAt = this.leaseDeadline(now, leaseMs);
      const candidate = this.database
        .prepare(
          `SELECT id FROM jobs
           WHERE state = 'pending' AND available_at <= ? AND attempts < max_attempts
           ORDER BY available_at, created_at
           LIMIT 1`,
        )
        .get(now);
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
