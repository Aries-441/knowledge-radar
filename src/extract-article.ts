import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import type { Article } from "./article.js";

const MIN_ARTICLE_CHARS = 200;
const MAX_ARTICLE_CHARS = 60_000;

export class ArticleExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleExtractionError";
  }
}

export function extractArticle(html: string, sourceUrl: string): Article {
  const document = new JSDOM(html, { url: sourceUrl });
  const parsed = new Readability(document.window.document).parse();
  const title = normalizeText(parsed?.title ?? document.window.document.title);
  const body = normalizeText(parsed?.textContent ?? "");

  if (!title || body.length < MIN_ARTICLE_CHARS) {
    throw new ArticleExtractionError("页面没有可用正文");
  }

  if (body.length > MAX_ARTICLE_CHARS) {
    throw new ArticleExtractionError("文章正文过长");
  }

  return { title, body, sourceUrl };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
