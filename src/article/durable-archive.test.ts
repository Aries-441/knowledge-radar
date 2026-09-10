import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpoint, publishCheckpoint, probeArchive, validateCheckpoint } from "./durable-archive.js";
import { createArchiveFilename, shortTaskId } from "./capture.js";
import { captureFailureText } from "./capture-error.js";
import * as filesystem from "node:fs/promises";

test("real no-clobber archive: same content reused, conflicts preserved, root bounded", async t => {
  const directory = await mkdtemp(join(process.env.RADAR_TEST_ARCHIVE_ROOT ?? tmpdir(), "radar-publish-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await probeArchive(directory), true);
  assert.equal(await probeArchive(undefined), false);
  assert.equal(await probeArchive(join(directory, "missing")), false);
  const cp = createCheckpoint("job", "https://example.com", { title: "完整标题".repeat(100), body: "NEVER_ARCHIVE_BODY", sourceUrl: "https://example.com/final" },
    { summary: "摘要", keyPoints: ["要点"] }, new Date(0), new Date(0));
  assert.ok(Buffer.byteLength(cp.filename) <= 174);
  assert.ok(!cp.markdown.includes("NEVER_ARCHIVE_BODY"));
  assert.match(cp.markdown, /1970-01-01/);
  await Promise.all([publishCheckpoint(directory, cp, () => {}), publishCheckpoint(directory, cp, () => {})]);
  const path = join(directory, cp.filename);
  assert.equal(await readFile(path, "utf8"), cp.markdown);
  await publishCheckpoint(directory, cp, () => {});
  assert.deepEqual(await readdir(directory), [cp.filename]);
  await writeFile(path, "user edit");
  await assert.rejects(publishCheckpoint(directory, cp, () => {}), { code: "archive_conflict" });
  assert.equal(await readFile(path, "utf8"), "user edit");
  await rm(path);
  await mkdir(path);
  await assert.rejects(publishCheckpoint(directory, cp, () => {}), { code: "archive_conflict" });
  await rm(path, { recursive: true });
  const target = join(directory, "user.md");
  await writeFile(target, "user");
  try { await symlink(target, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.diagnostic("Windows symlink privilege unavailable; Linux container covers symlink case"); return; } throw error; }
  await assert.rejects(publishCheckpoint(directory, cp, () => {}), { code: "archive_conflict" });
  assert.equal(await readFile(target, "utf8"), "user");
});

test("readable filenames are bounded, portable and deterministic", () => {
  const suffix = "--" + shortTaskId("job") + ".md";
  assert.equal(createArchiveFilename("job", "中文标题"), "中文标题" + suffix);
  assert.equal(createArchiveFilename("job", " CON.txt "), "_CON.txt" + suffix);
  assert.equal(createArchiveFilename("job", "LPT¹"), "_LPT¹" + suffix);
  assert.equal(createArchiveFilename("job", " ... "), "article" + suffix);
  for (const title of ['../bad\\name:<>"|?*\u0000', "文".repeat(1_000), "😀".repeat(1_000), "a".repeat(160) + "😀"]) {
    const name = createArchiveFilename("job", title);
    assert.ok(Buffer.byteLength(name) <= 174);
    assert.ok(name.isWellFormed());
    assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001f]/);
    assert.equal(name, createArchiveFilename("job", title));
  }
  assert.equal(createArchiveFilename("job", "e\u0301"), createArchiveFilename("job", "é"));
});

test("checkpoint freezes full metadata and title-first reply; old formats are rejected", async t => {
  const directory = await mkdtemp(join(tmpdir(), "radar-readable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const article = { title: "完整标题", sourceUrl: "https://example.com", body: "DO_NOT_ARCHIVE" };
  const summary = { summary: "摘要", keyPoints: ["要点"] };
  const cp = createCheckpoint("full-task-id", article.sourceUrl, article, summary, new Date(2_000), new Date(1_000));
  assert.deepEqual(validateCheckpoint("full-task-id", cp), cp);
  assert.match(cp.markdown, /^# 完整标题\n/);
  assert.match(cp.markdown, /任务创建时间：1970-01-01T00:00:01.000Z/);
  assert.match(cp.markdown, /摘要生成时间：1970-01-01T00:00:02.000Z/);
  assert.match(cp.markdown, /任务 ID：full-task-id/);
  assert.doesNotMatch(cp.markdown, /DO_NOT_ARCHIVE|任务状态|投递状态/);
  assert.equal(cp.replyText, "完整标题\n\n摘要：摘要\n\n要点：\n- 要点\n\n归档：" + cp.filename + "\n任务：" + shortTaskId("full-task-id"));
  assert.equal(captureFailureText("full-task-id", "capture_not_found", false),
    "采集失败：文章不存在或已被删除。\n\n任务：" + shortTaskId("full-task-id"));
  for (const invalid of [{ ...cp, version: 1 }, { ...cp, taskId: "other" }, { ...cp, taskCreatedAt: "invalid" },
    { ...cp, filename: "../escape.md" }, { ...cp, title: "different" }]) {
    assert.throws(() => validateCheckpoint("full-task-id", invalid), { code: "capture_summary_failed" });
  }
  await assert.rejects(publishCheckpoint(directory, { ...cp, filename: "../escape.md" }, () => {}), { code: "archive_conflict" });
  const a = createCheckpoint("collision-55045", article.sourceUrl, article, summary, new Date(0), new Date(0));
  const b = createCheckpoint("collision-70885", article.sourceUrl, article, summary, new Date(0), new Date(0));
  assert.equal(a.filename, b.filename); // Real SHA-256 32-bit prefix collision.
  await publishCheckpoint(directory, a, () => {});
  await assert.rejects(publishCheckpoint(directory, b, () => {}), { code: "archive_conflict" });
  assert.equal(await readFile(join(directory, a.filename), "utf8"), a.markdown);
  assert.deepEqual(await readdir(directory), [a.filename]);
});

test("write failures clean owned partial temp files; permission/disk failures are permanent", async t => {
  const directory = await mkdtemp(join(tmpdir(), "radar-publish-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cp = createCheckpoint("job", "https://example.com", { title: "Title", sourceUrl: "https://example.com", body: "" },
    { summary: "Summary", keyPoints: ["Point"] }, new Date(0), new Date(0));
  assert.equal(await probeArchive(directory, { ...filesystem, open: async () => { throw Object.assign(Error("private"), { code: "EACCES" }); } }), false);
  assert.equal(await probeArchive(directory, { ...filesystem, link: async () => { throw Object.assign(Error("private"), { code: "ENOTSUP" }); } }), false);
  assert.deepEqual(await readdir(directory), []);
  assert.equal(await probeArchive(directory), true);
  for (const code of ["ENOSPC", "EPERM", "EIO"]) {
    await assert.rejects(publishCheckpoint(directory, cp, () => {}, { ...filesystem,
      open: async (...args) => {
        const handle = await filesystem.open(...args);
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async () => { await write("partial"); throw Object.assign(new Error("sensitive path"), { code }); };
        return handle;
      } }), { code: "archive_write_failed", permanent: code !== "EIO" });
    assert.deepEqual(await readdir(directory), []);
  }
});

test("late no-clobber link can only publish the same committed snapshot", async t => {
  const directory = await mkdtemp(join(tmpdir(), "radar-late-publish-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cp = createCheckpoint("job", "https://example.com", { title: "Title", sourceUrl: "https://example.com", body: "" },
    { summary: "Summary", keyPoints: ["Point"] }, new Date(0), new Date(0));
  let linkStarted!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { linkStarted = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let valid = true;
  const older = publishCheckpoint(directory, cp, () => { assert.equal(valid, true); }, { ...filesystem,
    link: async (...args) => { linkStarted(); await pending; await filesystem.link(...args); } });
  await ready;
  valid = false;
  await publishCheckpoint(directory, cp, () => {});
  release(); await older;
  assert.deepEqual(await readdir(directory), [cp.filename]);
  assert.equal(await readFile(join(directory, cp.filename), "utf8"), cp.markdown);
});
