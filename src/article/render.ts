import { chromium, type Request, type Browser } from "playwright";
import type { Article } from "./model.js";
import { extractArticle } from "./extract.js";
import { isPublicUrl } from "./request.js";
import { CaptureError, CaptureCleanupError } from "./capture-error.js";

type ResourceType = ReturnType<Request["resourceType"]>;
const ALLOWED_RESOURCE_TYPES = new Set<ResourceType>(["document", "stylesheet", "script", "xhr", "fetch"]);
export class ArticleRenderError extends Error {
  constructor(message: string) { super(message); this.name = "ArticleRenderError"; }
}

export function checkPublicResponse(status: number, contentType: string, retryAfter?: string, now = Date.now()): void {
  if (status === 401) throw new CaptureError("capture_login_required", true);
  if (status === 403) throw new CaptureError("capture_access_blocked", true);
  if (status === 404 || status === 410) throw new CaptureError("capture_not_found", true);
  if (status === 429 || status >= 500) {
    const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
    const delay = Math.ceil(Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter ?? "") - now);
    throw new CaptureError("capture_fetch_failed", false, Number.isSafeInteger(now + delay) && delay > 0 ? delay : 0);
  }
  if (status < 200 || status >= 400) throw new CaptureError("capture_fetch_failed", true);
  if (!/^(text\/html|application\/xhtml\+xml)(\s*;|$)/i.test(contentType)) throw new CaptureError("capture_unsupported_content", true);
}

export async function renderPublicArticle(urlValue: string, options: {
  signal?: AbortSignal; timeoutMs?: number; publicOnly?: boolean;
  launch?: typeof chromium.launch;
} = {}): Promise<Article> {
  if (!isPublicUrl(urlValue)) throw new ArticleRenderError("仅支持不含凭据的公开 HTTP 或 HTTPS URL");
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (browser) closing ??= browser.close();
    return closing;
  };
  const abort = () => { void close()?.catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    browser = await (options.launch ?? chromium.launch.bind(chromium))({ headless: true,
      executablePath: process.env.KNOWLEDGE_RADAR_BROWSER_PATH, timeout: options.timeoutMs ?? 20_000 });
    options.signal?.throwIfAborted(); // A late launch still reaches finally and closes.
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    options.signal?.throwIfAborted();
    await context.route("**/*", async route => {
      if (shouldAllowRequest(route.request().url(), route.request().resourceType())) await route.continue();
      else await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    context.on("page", popup => { if (popup !== page) void popup.close().catch(() => {}); });
    const response = await page.goto(urlValue, { waitUntil: "domcontentloaded", timeout: Math.min(15_000, options.timeoutMs ?? 15_000) });
    if (options.publicOnly) {
      if (!response) throw new CaptureError("capture_fetch_failed");
      const headers = response.headers();
      checkPublicResponse(response.status(), headers["content-type"] ?? "", headers["retry-after"]);
    }
    await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
    options.signal?.throwIfAborted();
    if (!isPublicUrl(page.url())) throw new CaptureError("capture_access_blocked", true);
    const html = await page.content();
    if (html.length > 2_000_000) {
      if (options.publicOnly) throw new CaptureError("capture_content_too_large", true);
      throw new ArticleRenderError("渲染后的页面过大");
    }
    return extractArticle(html, page.url(), options.publicOnly);
  } catch (error) {
    if (!options.publicOnly || error instanceof CaptureError) throw error;
    throw new CaptureError(options.signal?.aborted || (error as Error)?.name === "TimeoutError" ? "capture_timeout" : "capture_fetch_failed");
  } finally {
    options.signal?.removeEventListener("abort", abort);
    try { await close(); } catch { throw new CaptureCleanupError(); }
  }
}

export function shouldAllowRequest(urlValue: string, resourceType: ResourceType): boolean {
  return ALLOWED_RESOURCE_TYPES.has(resourceType) && isPublicUrl(urlValue);
}
