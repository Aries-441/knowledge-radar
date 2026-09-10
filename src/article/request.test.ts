import assert from "node:assert/strict";
import test from "node:test";
import { classifyCaptureRequest as classify } from "./request.js";

test("explicit capture is pure, bounded and does not rewrite punctuation or query", () => {
  for (const input of ["https://example.com/a?q=1。", " 总结\t https://example.com/a?q=1。 \n"]) {
    assert.deepEqual(classify(input), { kind: "capture", url: "https://example.com/a?q=1%E3%80%82" });
  }
  for (const input of ["看看 https://example.com", "https://a.com https://b.com", "[文章](https://a.com)", "总结一下这个方案"]) {
    assert.deepEqual(classify(input), { kind: "chat" });
  }
  for (const input of ["总结", "总结 xx yy", "总结 https://a.com https://b.com"]) {
    assert.deepEqual(classify(input), { kind: "reject", code: "capture_invalid_request" });
  }
  for (const input of ["总结 nope", "file:///x", "ftp://a.com", "https://user:secret@a.com", "http://127.0.0.1", "http://[::1]", "http://localhost", "http://10.0.0.1", "https://"]) {
    assert.deepEqual(classify(input), { kind: "reject", code: "capture_invalid_url" });
  }
  const url = "https://a.com/";
  assert.equal(classify(url + "x".repeat(4_000 - url.length)).kind, "capture");
  assert.deepEqual(classify(url + "x".repeat(4_001 - url.length)), { kind: "reject", code: "capture_input_too_large" });
  for (const local of ["http://[::]", "http://[::ffff:127.0.0.1]"]) assert.equal(classify(local).kind, "reject");
});
