import assert from "node:assert/strict";
import test from "node:test";
import { getSourceCardTheme, resolveSourceCardTheme } from "./card-themes.js";

test("resolves explicit source kinds to distinct themes", () => {
  assert.equal(getSourceCardTheme("rss").headerTemplate, "turquoise");
  assert.equal(getSourceCardTheme("github_trending").headerTemplate, "indigo");
  assert.equal(getSourceCardTheme("github_releases").headerTemplate, "purple");
  assert.equal(getSourceCardTheme("arxiv").sectionBackground, "violet-50");
  assert.equal(getSourceCardTheme("newsletter").sectionBackground, "orange-50");
  assert.equal(getSourceCardTheme("wechat").sectionBackground, "green-50");
});

test("uses metadata provider for legacy candidates and a safe fallback", () => {
  assert.equal(resolveSourceCardTheme({ metadata: { provider: "github_trending" } }).kind, "github_trending");
  assert.equal(resolveSourceCardTheme({ sourceKind: "github_trending", metadata: { provider: "rss" } }).kind, "github_trending");
  assert.equal(resolveSourceCardTheme({ sourceKind: "future_connector" }).kind, "unknown");
  assert.match(resolveSourceCardTheme({ sourceKind: "future_connector" }).accessibleLabel, /其他来源/);
});
