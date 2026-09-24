import { runCli } from "./cli/command.js";

process.exitCode = await runCli(process.argv.slice(2), {
  serveFeishu: async (config, feedConfig) => {
    const { serveFeishu } = await import("./runtime/feishu-service.js");
    const { replyWithPi } = await import("./agent/topic-runtime.js");
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const result = await serveFeishu({ config, feedConfig, agent: replyWithPi, signal: controller.signal,
        log: record => console.error(JSON.stringify(record)) });
      if (!result.drained) process.exit(1);
      return result.exitCode;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  },
  agent: async (request) => {
    const { replyWithPi } = await import("./agent/topic-runtime.js");
    return replyWithPi(request);
  },
  capture: async (url) => {
    const { summarizeWithPi } = await import("./agent/article-summary.js");
    const { captureArticle } = await import("./article/capture.js");
    const { renderPublicArticle } = await import("./article/render.js");
    return captureArticle(url, {
      archiveDir: process.env.KNOWLEDGE_RADAR_ARCHIVE_DIR ?? "/archive",
      renderArticle: renderPublicArticle,
      summarize: summarizeWithPi,
    });
  },
});
