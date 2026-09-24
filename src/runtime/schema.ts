import type { DatabaseSync } from "node:sqlite";

import { numberValue } from "./serialization.js";
import { RuntimeStoreError } from "./types.js";

const SCHEMA_VERSION = 5;

export function migrateRuntimeSchema(database: DatabaseSync, transaction: <T>(operation: () => T) => T): void {
  transaction(() => {
    const current = numberValue(database.prepare("PRAGMA user_version").get(), "user_version");
    if (current > SCHEMA_VERSION) {
      throw new RuntimeStoreError(`State database version ${current} is newer than supported version ${SCHEMA_VERSION}`);
    }
    if (current === SCHEMA_VERSION) return;
    const exists = (name: string) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name));

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
    if (current < 2 && !exists("feishu_chats")) database.exec(`
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
    if (current < 3 && !exists("article_captures")) database.exec(`
      CREATE UNIQUE INDEX capture_origin_unique ON jobs(origin_turn_id)
        WHERE kind = 'capture_article' AND origin_turn_id IS NOT NULL;
      CREATE TABLE article_captures (
        job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id),
        result_json TEXT NOT NULL CHECK(json_valid(result_json))
      ) STRICT;
      PRAGMA user_version = 3;
    `);
    if (current < 4 && !exists("feed_sources")) database.exec(`
      CREATE TABLE feed_sources (
        id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
        url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array' AND length(tags_json) <= 4096),
        etag TEXT CHECK (etag IS NULL OR length(etag) <= 1024),
        last_modified TEXT CHECK (last_modified IS NULL OR length(last_modified) <= 256),
        baseline_at INTEGER,
        last_checked_at INTEGER,
        last_success_at INTEGER,
        error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 128),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE feed_items (
        id TEXT PRIMARY KEY NOT NULL,
        feed_id TEXT NOT NULL REFERENCES feed_sources(id) ON DELETE CASCADE,
        identity_key TEXT NOT NULL CHECK (length(identity_key) BETWEEN 1 AND 2048),
        canonical_url TEXT CHECK (canonical_url IS NULL OR length(canonical_url) BETWEEN 1 AND 2048),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 1024),
        summary TEXT CHECK (summary IS NULL OR length(summary) <= 8192),
        author TEXT CHECK (author IS NULL OR length(author) <= 512),
        published_at INTEGER,
        first_seen_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('baseline', 'candidate')),
        error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 128),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (feed_id, identity_key)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS feed_sources_enabled_priority_index ON feed_sources(enabled, priority, id);
      CREATE INDEX IF NOT EXISTS feed_items_feed_state_first_seen_index ON feed_items(feed_id, state, first_seen_at);
      CREATE INDEX IF NOT EXISTS feed_items_published_index ON feed_items(published_at);
      CREATE INDEX IF NOT EXISTS jobs_kind_claim_index ON jobs(kind, state, available_at, created_at, id);
      PRAGMA user_version = 4;
    `);
    if (current < 5) {
      if (!database.prepare("PRAGMA table_info(feed_items)").all().some(row => row.name === "notified_at")) {
        database.exec("ALTER TABLE feed_items ADD COLUMN notified_at INTEGER");
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS feed_items_unnotified_index ON feed_items(state, notified_at, feed_id);
        PRAGMA user_version = 5;
      `);
    }
  });
}
