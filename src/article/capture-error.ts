import { shortTaskId } from "./capture.js";

export const captureReasons = {
  capture_invalid_request: "请单独发送一个公开链接，或使用：总结 <URL>。",
  capture_invalid_url: "仅支持不含凭据的公开 HTTP(S) 链接。",
  capture_input_too_large: "采集请求超过 4,000 字符，请缩短链接。",
  capture_unavailable: "采集当前不可用，请检查归档目录配置；文字聊天仍可使用。",
  capture_login_required: "页面需要登录，当前仅支持公开文章。",
  capture_access_blocked: "页面访问受阻或需要验证码，当前不会自动验证。",
  capture_not_found: "文章不存在或已被删除。",
  capture_unsupported_content: "链接不是可处理的 HTML 文章。",
  capture_no_content: "页面没有可用正文。",
  capture_content_too_large: "文章正文超过处理上限。",
  capture_fetch_failed: "网页访问失败。",
  capture_timeout: "采集超时。",
  capture_summary_failed: "未能生成符合要求的摘要。",
  capture_configuration: "摘要模型配置不可用。",
  archive_write_failed: "归档文件写入失败。",
  archive_conflict: "归档路径已有不同内容或非普通文件，已保留原文件。",
  capture_interrupted: "任务中断，未能确认完成。",
} as const;
export type CaptureErrorCode = keyof typeof captureReasons;
export class CaptureError extends Error {
  constructor(readonly code: CaptureErrorCode, readonly permanent = false, readonly retryAfterMs = 0) {
    super(code); this.name = "CaptureError";
  }
}
export class CaptureCleanupError extends Error {
  constructor() { super("capture_cleanup_failed"); this.name = "CaptureCleanupError"; }
}
export function captureFailureText(jobId: string, code: CaptureErrorCode, checkpointExists: boolean): string {
  return `采集失败：${captureReasons[code]}${checkpointExists ? " 可能已留下归档文件，请核对。" : ""}\n\n任务：${shortTaskId(jobId)}`;
}
