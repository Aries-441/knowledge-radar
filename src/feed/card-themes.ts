import type { FeedItemMetadata } from "../runtime/types.js";

export type SourceCardThemeKind =
  | "rss"
  | "github_trending"
  | "github_release"
  | "arxiv"
  | "newsletter"
  | "wechat"
  | "unknown";

export type SourceCardTheme = {
  kind: SourceCardThemeKind;
  headerTemplate: string;
  sectionBackground: string;
  badgeText: string;
  accessibleLabel: string;
};

export type SourceThemeInput = {
  sourceKind?: string | null;
  metadata?: FeedItemMetadata;
};

const THEMES: Readonly<Record<SourceCardThemeKind, SourceCardTheme>> = Object.freeze({
  rss: Object.freeze({
    kind: "rss", headerTemplate: "turquoise", sectionBackground: "turquoise-50",
    badgeText: "📰 博客", accessibleLabel: "博客订阅源",
  }),
  github_trending: Object.freeze({
    kind: "github_trending", headerTemplate: "indigo", sectionBackground: "indigo-50",
    badgeText: "◈ GitHub 热点", accessibleLabel: "GitHub Trending 来源",
  }),
  github_release: Object.freeze({
    kind: "github_release", headerTemplate: "purple", sectionBackground: "purple-50",
    badgeText: "◈ GitHub Releases", accessibleLabel: "GitHub Releases 来源",
  }),
  arxiv: Object.freeze({
    kind: "arxiv", headerTemplate: "violet", sectionBackground: "violet-50",
    badgeText: "⌁ arXiv", accessibleLabel: "arXiv 来源",
  }),
  newsletter: Object.freeze({
    kind: "newsletter", headerTemplate: "orange", sectionBackground: "orange-50",
    badgeText: "✉ Newsletter", accessibleLabel: "Newsletter 来源",
  }),
  wechat: Object.freeze({
    kind: "wechat", headerTemplate: "green", sectionBackground: "green-50",
    badgeText: "◎ 公众号", accessibleLabel: "微信公众号来源",
  }),
  unknown: Object.freeze({
    kind: "unknown", headerTemplate: "grey", sectionBackground: "grey-50",
    badgeText: "• 其他来源", accessibleLabel: "其他来源",
  }),
});

function normalized(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function themeKind(value: string): SourceCardThemeKind | null {
  if (value === "rss" || value === "atom") return "rss";
  if (value === "github_trending" || value === "github_trend") return "github_trending";
  if (value === "github_release" || value === "github_releases") return "github_release";
  if (value === "arxiv") return "arxiv";
  if (value === "newsletter" || value === "email_newsletter") return "newsletter";
  if (value === "wechat" || value === "wechat_official_account" || value === "weixin") return "wechat";
  return null;
}

/** Resolves a visual theme without coupling card appearance to a source ID. */
export function resolveSourceCardTheme(input: SourceThemeInput): SourceCardTheme {
  const explicit = themeKind(normalized(input.sourceKind));
  if (explicit) return THEMES[explicit];
  const provider = typeof input.metadata?.provider === "string"
    ? themeKind(normalized(input.metadata.provider)) : null;
  return THEMES[provider ?? "unknown"];
}

export function getSourceCardTheme(kind: string | null | undefined): SourceCardTheme {
  return THEMES[themeKind(normalized(kind)) ?? "unknown"];
}
