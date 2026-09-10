import type { DatabaseSync } from "node:sqlite";

import { numberValue } from "./serialization.js";
import { RuntimeStoreError } from "./types.js";

const SCHEMA_VERSION = 3;

export function migrateRuntimeSchema(database: DatabaseSync, transaction: <T>(operation: () => T) => T): void {
  transaction(() => {
    const current = numberValue(database.prepare("PRAGMA user_version").get(), "user_version");
    if (current > SCHEMA_VERSION) {
      throw new RuntimeStoreError(`State database version ${current} is newer than supported version ${SCHEMA_VERSION}`);
    }
    if (current === SCHEMA_VERSION) return;

    if (current === 0) database.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE turns (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'answered', 'failed')),
        available_at INTEGER NOT NULL,
        run_token TEXT,
        lease_expires_at INTEGER,
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (conversation_id, sequence)
      ) STRICT;

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY NOT NULL,
        origin_turn_id TEXT REFERENCES turns(id),
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        result_json TEXT,
        error_code TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
        available_at INTEGER NOT NULL,
        run_token TEXT,
        lease_expires_at INTEGER,
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE outbox (
        id TEXT PRIMARY KEY NOT NULL,
        turn_id TEXT NOT NULL REFERENCES turns(id),
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        error_code TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed')),
        available_at INTEGER NOT NULL,
        run_token TEXT,
        lease_expires_at INTEGER,
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (turn_id, kind)
      ) STRICT;

      CREATE INDEX turns_claim_index ON turns (conversation_id, sequence);
      CREATE INDEX jobs_claim_index ON jobs (state, available_at, created_at);
      CREATE INDEX outbox_claim_index ON outbox (state, available_at, created_at);
      PRAGMA user_version = 1;
    `);
    if (current < 2) database.exec(`
      CREATE TABLE feishu_chats (
        app_id TEXT NOT NULL,
        tenant_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        owner_open_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (app_id, tenant_key, chat_id)
      ) STRICT;
      CREATE TABLE feishu_inbound_messages (
        app_id TEXT NOT NULL,
        tenant_key TEXT NOT NULL,
        message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (app_id, tenant_key, message_id),
        FOREIGN KEY (app_id, tenant_key, chat_id)
          REFERENCES feishu_chats(app_id, tenant_key, chat_id)
      ) STRICT;
      CREATE INDEX feishu_owner_index ON feishu_chats(app_id, tenant_key, owner_open_id);
      PRAGMA user_version = 2;
    `);
    database.exec(`
      CREATE UNIQUE INDEX capture_origin_unique ON jobs(origin_turn_id)
        WHERE kind = 'capture_article' AND origin_turn_id IS NOT NULL;
      CREATE TABLE article_captures (
        job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id),
        result_json TEXT NOT NULL CHECK(json_valid(result_json))
      ) STRICT;
      PRAGMA user_version = 3;
    `);
  });
}
