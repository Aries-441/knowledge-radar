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

test("v3 to v7 migration preserves rows, creates connector columns and feedback tables, and is idempotent", () => {
  const database = createV3Database();
  try {
    migrateRuntimeSchema(database, (operation) => transaction(database, operation));
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 7);
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
    for (const index of ["feed_sources_enabled_priority_index", "feed_items_feed_state_first_seen_index", "feed_items_published_index", "feed_items_unnotified_index"]) {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(index));
    }
    for (const table of ["digest_messages", "digest_feedback", "digest_feedback_events"]) {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    }
    migrateRuntimeSchema(database, (operation) => transaction(database, operation));
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 7);
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
