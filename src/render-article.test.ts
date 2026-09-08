import assert from "node:assert/strict";
import test from "node:test";

import { ArticleExtractionError, extractArticle } from "./extract-article.js";
import { ArticleRenderError, shouldAllowRequest } from "./render-article.js";

const renderedArticleHtml = `<!doctype html>
<html><head><title>Dynamic knowledge inbox</title></head><body>
  <nav>Navigation that is not article content</nav>
  <article><h1>Dynamic knowledge inbox</h1><p>${"Useful client-rendered article content. ".repeat(20)}</p></article>
</body></html>`;

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
