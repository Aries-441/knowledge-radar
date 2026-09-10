import assert from "node:assert/strict";
import test from "node:test";

import { ArticleExtractionError, extractArticle } from "./extract.js";
import { ArticleRenderError, shouldAllowRequest, checkPublicResponse, renderPublicArticle } from "./render.js";
import type { Browser } from "playwright";

const renderedArticleHtml = `<!doctype html>
<html><head><title>Dynamic knowledge inbox</title></head><body>
  <nav>Navigation that is not article content</nav>
  <article><h1>Dynamic knowledge inbox</h1><p>${"Useful client-rendered article content. ".repeat(20)}</p></article>
</body></html>`;

test("public HTTP failures and explicit walls stop before summary", () => {
  for (const [status, code] of [[401, "capture_login_required"], [403, "capture_access_blocked"], [404, "capture_not_found"],
    [410, "capture_not_found"], [429, "capture_fetch_failed"], [500, "capture_fetch_failed"]] as const) {
    assert.throws(() => checkPublicResponse(status, "text/html"), { code });
  }
  assert.throws(() => checkPublicResponse(429, "text/html", "60", 0), { retryAfterMs: 60_000 });
  assert.throws(() => checkPublicResponse(200, "application/pdf"), { code: "capture_unsupported_content" });
  assert.throws(() => extractArticle('<title>登录</title><form action="/login"><input type="password"></form>', "https://example.com", true), { code: "capture_login_required" });
  assert.throws(() => extractArticle('<title>安全验证</title><p>请验证</p>', "https://example.com", true), { code: "capture_access_blocked" });
  assert.throws(() => extractArticle('<title>Empty</title>', "https://example.com", true), { code: "capture_no_content" });
  assert.throws(() => extractArticle(`<title>Huge</title><article><p>${"x".repeat(60_001)}</p></article>`, "https://example.com", true), { code: "capture_content_too_large" });
  assert.ok(extractArticle(renderedArticleHtml.replaceAll("Dynamic knowledge inbox", "登录技术详解"), "https://example.com", true).body.length > 200);
});

test("late browser launch after abort is closed, never navigated", async () => {
  let launch!: (browser: Browser) => void;
  const controller = new AbortController();
  let closed = false;
  const pending = renderPublicArticle("https://example.com", { signal: controller.signal, publicOnly: true,
    launch: async () => new Promise(resolve => { launch = resolve; }) });
  controller.abort();
  launch({ close: async () => { closed = true; }, newContext: () => assert.fail("late browser cannot navigate") } as unknown as Browser);
  await assert.rejects(pending, { code: "capture_timeout" });
  assert.equal(closed, true);
});

test("aborting a pending navigation closes the actual browser handle", async () => {
  let started!: () => void, rejectNavigation!: (error: Error) => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let closed = false;
  const controller = new AbortController();
  const browser = { close: async () => { closed = true; rejectNavigation(Error("closed")); },
    newContext: async () => ({ route: async () => {}, on() {}, newPage: async () => ({
      goto: async () => { started(); return new Promise((_, reject) => { rejectNavigation = reject; }); },
    }) }) } as unknown as Browser;
  const pending = renderPublicArticle("https://example.com", { publicOnly: true, signal: controller.signal, launch: async () => browser });
  await ready; controller.abort();
  await assert.rejects(pending, { code: "capture_timeout" });
  assert.equal(closed, true);
});

test("allows document, script, stylesheet, XHR, and fetch requests", () => {
  for (const resourceType of ["document", "script", "stylesheet", "xhr", "fetch"] as const) {
    assert.equal(shouldAllowRequest("https://www.cnblogs.com/article", resourceType), true);
  }
});

test("blocks nonessential resources and explicit local targets", () => {
  assert.equal(shouldAllowRequest("https://example.com/image.png", "image"), false);
  assert.equal(shouldAllowRequest("https://example.com/font.woff2", "font"), false);
  assert.equal(shouldAllowRequest("http://127.0.0.1/article", "document"), false);
  assert.equal(shouldAllowRequest("http://192.168.1.10/article", "document"), false);
  assert.equal(shouldAllowRequest("http://[::1]/article", "document"), false);
  assert.equal(shouldAllowRequest("file:///etc/passwd", "document"), false);
});

test("rejects embedded credentials", () => {
  assert.equal(shouldAllowRequest("https://user:secret@example.com/article", "document"), false);
});

test("extracts the final DOM after a page has rendered", () => {
  const article = extractArticle(renderedArticleHtml, "https://example.com/article");
  assert.equal(article.title, "Dynamic knowledge inbox");
  assert.match(article.body, /Useful client-rendered article content/);
});

test("rejects pages without enough readable content", () => {
  assert.throws(
    () => extractArticle("<html><head><title>Login</title></head><body>Please sign in</body></html>", "https://example.com/login"),
    ArticleExtractionError,
  );
});

test("uses one error type for an invalid initial URL", () => {
  assert.throws(() => {
    if (!shouldAllowRequest("file:///etc/passwd", "document")) {
      throw new ArticleRenderError("仅支持不含凭据的公开 HTTP 或 HTTPS URL");
    }
  }, ArticleRenderError);
});
