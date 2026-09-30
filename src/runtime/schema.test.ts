import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { migrateRuntimeSchema } from "./schema.js";

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function createV3Database(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  migrateRuntimeSchema(database, (operation) => transaction(database, operation));
  // Recreate the pre-v4 schema through the supported version 3 path.
  database.exec("DROP TABLE digest_feedback_events; DROP TABLE digest_feedback; DROP TABLE digest_messages;");
  database.exec(`
    DROP TABLE feed_items;
    DROP TABLE feed_sources;
    PRAGMA user_version = 3;
    INSERT INTO conversations VALUES ('c1', 'general', 'saved', 'active', 1, 1);
    INSERT INTO turns VALUES ('t1', 'c1', 1, 'test', 'saved turn', 'answered', 1, NULL, NULL, 0, 2, NULL, 1, 1);
    INSERT INTO jobs VALUES ('j1', NULL, 'capture_article', '{}', 'key1', '{}', NULL, 'succeeded', 1, NULL, NULL, 0, 2, 1, 1);
    INSERT INTO outbox VALUES ('o1', 't1', 'final', '{}', NULL, 'sent', 1, NULL, NULL, 0, 2, 1, 1);
    INSERT INTO article_captures VALUES ('j1', '{}');
  `);
  return database;
}

test("v3 to v8 migration preserves rows, creates connector columns and feedback tables, and is idempotent", () => {
  const database = createV3Database();
  try {
    migrateRuntimeSchema(database, (operation) => transaction(database, operation));
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 8);
    for (const table of ["conversations", "turns", "jobs", "outbox", "article_captures"]) {
      const count = database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count;
      assert.equal(count, 1, `${table} row should survive`);
    }
    for (const table of ["feed_sources", "feed_items"]) {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    }
    const columns = database.prepare("PRAGMA table_info(feed_sources)").all().map(row => row.name);
    assert.ok(columns.includes("kind"));
    assert.ok(columns.includes("connector_config_json"));
    const itemColumns = database.prepare("PRAGMA table_info(feed_items)").all().map(row => row.name);
    assert.ok(itemColumns.includes("metadata_json"));
    for (const index of ["feed_sources_enabled_priority_index", "feed_items_feed_state_first_seen_index", "feed_items_published_index", "feed_items_unnotified_index"]) {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(index));
    }
    for (const table of ["digest_messages", "digest_feedback", "digest_feedback_events"]) {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    }
    migrateRuntimeSchema(database, (operation) => transaction(database, operation));
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 8);
    assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'feed_%'").get()?.count, 6);
  } finally {
    database.close();
  }
});

test("failed v3 to v4 migration rolls back tables and user_version", () => {
  const database = createV3Database();
  // The conflicting second object injects a deterministic failure after feed_sources is created.
  database.exec("CREATE TABLE feed_items (id TEXT)");
  try {
    assert.throws(() => migrateRuntimeSchema(database, (operation) => transaction(database, operation)));
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 3);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feed_sources'").get(), undefined);
  } finally {
    database.close();
  }
});

test("failed v7 to v8 migration rolls back metadata column and user_version", () => {
  const database = createV3Database();
  try {
    migrateRuntimeSchema(database, (operation) => transaction(database, operation));
    database.exec("ALTER TABLE feed_items DROP COLUMN metadata_json; PRAGMA user_version = 7;");
    assert.throws(() => migrateRuntimeSchema(database, operation => transaction(database, () => {
      operation();
      throw new Error("inject v8 failure");
    })));
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 7);
    assert.equal(database.prepare("PRAGMA table_info(feed_items)").all().some(row => row.name === "metadata_json"), false);
  } finally {
    database.close();
  }
});

test("v7 to v8 migration preserves feed items and feedback rows", () => {
  const database = createV3Database();
  try {
    migrateRuntimeSchema(database, (operation) => transaction(database, operation));
    database.exec("ALTER TABLE feed_items DROP COLUMN metadata_json; PRAGMA user_version = 7;");
    database.prepare(`INSERT INTO feed_sources
      (id, display_name, url, enabled, priority, tags_json, etag, last_modified, baseline_at,
       last_checked_at, last_success_at, error_code, created_at, updated_at, kind, connector_config_json)
      VALUES (?, ?, ?, 1, 0, '[]', NULL, NULL, NULL, NULL, NULL, NULL, 1, 1, 'github_trending', '{}')`)
      .run("github", "GitHub", "https://github.com/trending");
    database.prepare(`INSERT INTO feed_items
      (id, feed_id, identity_key, canonical_url, title, summary, author, published_at, first_seen_at,
       state, error_code, created_at, updated_at, notified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', NULL, ?, ?, NULL)`)
      .run("item", "github", "github:owner/repo", "https://github.com/owner/repo", "owner/repo", "summary", "owner", null, 1, 1, 1);
    database.prepare(`INSERT INTO digest_messages
      (message_id, app_id, tenant_key, owner_open_id, card_json, item_ids_json, created_at)
      VALUES ('message', 'app', 'tenant', 'owner', '{"schema":"2.0"}', '["item"]', 1)`).run();
    database.prepare(`INSERT INTO digest_feedback
      (app_id, tenant_key, owner_open_id, feed_item_id, interested, last_message_id, updated_at)
      VALUES ('app', 'tenant', 'owner', 'item', 1, 'message', 1)`).run();
    database.prepare(`INSERT INTO digest_feedback_events
      (event_id, app_id, tenant_key, owner_open_id, message_id, feed_item_id, target_interested, received_at)
      VALUES ('event', 'app', 'tenant', 'owner', 'message', 'item', 1, 1)`).run();

    migrateRuntimeSchema(database, (operation) => transaction(database, operation));
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 8);
    assert.equal(database.prepare("SELECT metadata_json FROM feed_items WHERE id = 'item'").get()?.metadata_json, "{}");
    assert.equal(database.prepare("SELECT count(*) AS count FROM digest_feedback").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM digest_feedback_events").get()?.count, 1);
  } finally {
    database.close();
  }
});
