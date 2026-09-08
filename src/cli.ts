import { summarizeWithPi } from "./agent-runtime.js";
import { captureArticle } from "./capture-article.js";
import { renderPublicArticle } from "./render-article.js";

const url = process.argv[2];
const archiveDir = process.env.KNOWLEDGE_RADAR_ARCHIVE_DIR ?? "/archive";

if (!url) {
  console.error("用法: knowledge-radar <公开文章 URL>");
  process.exitCode = 1;
} else {
  try {
    const result = await captureArticle(url, {
      archiveDir,
      renderArticle: renderPublicArticle,
      summarize: summarizeWithPi,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "文章归档失败");
    process.exitCode = 1;
  }
}
