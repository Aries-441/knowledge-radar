import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import type { Article } from "./model.js";
import { CaptureError } from "./capture-error.js";

const MIN_ARTICLE_CHARS = 200;
const MAX_ARTICLE_CHARS = 60_000;

export class ArticleExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleExtractionError";
  }
}

export function extractArticle(html: string, sourceUrl: string, publicOnly = false): Article {
  const document = new JSDOM(html, { url: sourceUrl });
  try {
  if (publicOnly) {
    const dom = document.window.document;
    const title = dom.title.trim();
    // ponytail: explicit wall evidence only; site-specific walls need future fixtures.
    if (/^(安全验证|人机验证|访问验证|验证码|access denied|just a moment|security check)(\s|[.!。…]|$)/i.test(title)
      || dom.querySelector('form[action*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]')) {
      throw new CaptureError("capture_access_blocked", true);
    }
    if (/^(登录|登陆|请登录|sign in|log in|login)(\s|[|\-—:：]|$)/i.test(title)
      && (dom.querySelector('input[type="password"], form[action*="login"], form[action*="signin"]')
        || (dom.body?.textContent?.trim().length ?? 0) < 200)) throw new CaptureError("capture_login_required", true);
  }
  const parsed = new Readability(document.window.document).parse();
  const title = normalizeText(parsed?.title ?? document.window.document.title);
  const body = normalizeText(parsed?.textContent ?? "");

  if (!title || body.length < MIN_ARTICLE_CHARS) {
    if (publicOnly) throw new CaptureError("capture_no_content", true);
    throw new ArticleExtractionError("页面没有可用正文");
  }

  if (body.length > MAX_ARTICLE_CHARS) {
    if (publicOnly) throw new CaptureError("capture_content_too_large", true);
    throw new ArticleExtractionError("文章正文过长");
  }

  return { title, body, sourceUrl };
  } finally { document.window.close(); }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
