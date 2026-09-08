import { chromium, type Request } from "playwright";

import type { Article } from "./article.js";
import { extractArticle } from "./extract-article.js";

const NAVIGATION_TIMEOUT_MS = 15_000;
const NETWORK_IDLE_TIMEOUT_MS = 2_000;
const MAX_RENDERED_HTML_CHARS = 2_000_000;

type ResourceType = ReturnType<Request["resourceType"]>;

const ALLOWED_RESOURCE_TYPES = new Set<ResourceType>([
  "document",
  "stylesheet",
  "script",
  "xhr",
  "fetch",
]);

export class ArticleRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleRenderError";
  }
}

export async function renderPublicArticle(urlValue: string): Promise<Article> {
  const initialUrl = parseInitialUrl(urlValue);
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.KNOWLEDGE_RADAR_BROWSER_PATH,
  });

  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
    });

    try {
      await context.route("**/*", async (route) => {
        if (shouldAllowRequest(route.request().url(), route.request().resourceType())) {
          await route.continue();
          return;
        }
        await route.abort("blockedbyclient");
      });

      const page = await context.newPage();
      context.on("page", (popup) => {
        if (popup !== page) void popup.close().catch(() => undefined);
      });

      await page.goto(initialUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => undefined);

      const html = await page.content();
      if (html.length > MAX_RENDERED_HTML_CHARS) {
        throw new ArticleRenderError("渲染后的页面过大");
      }

      return extractArticle(html, page.url());
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

export function shouldAllowRequest(urlValue: string, resourceType: ResourceType): boolean {
  if (!ALLOWED_RESOURCE_TYPES.has(resourceType)) return false;

  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return !isExplicitlyLocalHost(url.hostname);
}

function parseInitialUrl(urlValue: string): string {
  if (!shouldAllowRequest(urlValue, "document")) {
    throw new ArticleRenderError("仅支持不含凭据的公开 HTTP 或 HTTPS URL");
  }
  return urlValue;
}

function isExplicitlyLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) {
    if (host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return true;
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
  }

  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}
