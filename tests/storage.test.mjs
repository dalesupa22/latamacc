import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { inspect } from "node:util";
import { loadStorageConfig, S3Storage } from "../lib/storage.mjs";

const saved = {
  AWS_ACCESS_KEY_ID: "fake-access-key", AWS_SECRET_ACCESS_KEY: "fake-secret-key",
  AWS_REGION: "us-east-1", AWS_S3_BUCKET: "storage-test", AWS_ACCOUNT_ID: "123456789012", AWS_IAM_USER: "TestUser",
};
const config = {
  region: saved.AWS_REGION, bucket: saved.AWS_S3_BUCKET, accountId: saved.AWS_ACCOUNT_ID, iamUser: saved.AWS_IAM_USER,
  credentials: { accessKeyId: saved.AWS_ACCESS_KEY_ID, secretAccessKey: saved.AWS_SECRET_ACCESS_KEY },
};

function temporaryConfig(t, value = saved) {
  const dir = mkdtempSync(join(tmpdir(), "latamacc-storage-test-")), file = join(dir, "s3.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return { dir, file };
}

function mockedStorage(t, response = {}) {
  const calls = [];
  let destroyed = 0;
  const client = {
    async send(command, options) { calls.push({ command, options }); return response; },
    destroy() { destroyed++; },
  };
  const storage = new S3Storage(config, { client });
  t.after(() => storage.close());
  return { storage, calls, destroyed: () => destroyed };
}

test("private configuration loads credentials and explicit environment overrides", t => {
  const { file } = temporaryConfig(t);
  assert.deepEqual(loadStorageConfig({ file, env: {} }), config);
  const overridden = loadStorageConfig({ file, env: { AWS_REGION: "eu-west-1", AWS_SESSION_TOKEN: "fake-session-token" } });
  assert.equal(overridden.region, "eu-west-1");
  assert.equal(overridden.credentials.sessionToken, "fake-session-token");
  assert.equal(overridden.bucket, config.bucket);
  assert.throws(() => loadStorageConfig({ file, env: { AWS_SECRET_ACCESS_KEY: "" } }), /both AWS access credentials/);
});

test("configuration rejects permissive files, symlinks, malformed JSON and missing explicit paths without leaking contents", t => {
  const { dir, file } = temporaryConfig(t);
  chmodSync(file, 0o644);
  assert.throws(() => loadStorageConfig({ file, env: {} }), /permissions 600/);
  chmodSync(file, 0o600);
  const link = join(dir, "link.json"); symlinkSync(file, link);
  assert.throws(() => loadStorageConfig({ file: link, env: {} }), /opened securely/);
  assert.throws(() => loadStorageConfig({ file: dir, env: {} }), /regular file/);
  for (const input of ['{"AWS_SECRET_ACCESS_KEY":"hidden-secret-fragment",', "null", "[]"]) {
    writeFileSync(file, input);
    assert.throws(() => loadStorageConfig({ file, env: {} }), error =>
      error.message.startsWith("S3 configuration unavailable:") && !error.message.includes("hidden-secret-fragment"));
  }
  assert.throws(() => loadStorageConfig({ file: join(dir, "absent"), env: saved }), /opened securely/);
  assert.throws(() => loadStorageConfig({ env: { ...saved, S3_CONFIG_FILE: join(dir, "absent") } }), /opened securely/);
});

test("configuration validates bucket, region, account owner and credential pair", t => {
  const { file } = temporaryConfig(t);
  for (const patch of [
    { AWS_REGION: "" }, { AWS_REGION: "us-east-1/evil" }, { AWS_S3_BUCKET: "" }, { AWS_S3_BUCKET: "INVALID" },
    { AWS_S3_BUCKET: "../bad" }, { AWS_S3_BUCKET: "127.0.0.1" }, { AWS_ACCOUNT_ID: "123" }, { AWS_ACCOUNT_ID: 123456789012 },
    { AWS_ACCESS_KEY_ID: "" }, { AWS_SECRET_ACCESS_KEY: "" }, { AWS_SESSION_TOKEN: "\n" },
  ]) {
    writeFileSync(file, JSON.stringify({ ...saved, ...patch }));
    assert.throws(() => loadStorageConfig({ file, env: {} }), /S3 configuration unavailable/);
  }
  const { AWS_IAM_USER, ...withoutUser } = saved;
  writeFileSync(file, JSON.stringify(withoutUser));
  assert.equal(loadStorageConfig({ file, env: {} }).iamUser, undefined);
});

test("absent default configuration is disabled and complete env-only configuration works in an isolated home", t => {
  const dir = mkdtempSync(join(tmpdir(), "latamacc-storage-home-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = `import assert from 'node:assert/strict';
    import { loadStorageConfig } from ${JSON.stringify(new URL("../lib/storage.mjs", import.meta.url).href)};
    assert.equal(loadStorageConfig({env:{}}),null);
    const c=loadStorageConfig({env:${JSON.stringify(saved)}});
    assert.equal(c.bucket,'storage-test');
    assert.equal(c.credentials.secretAccessKey,'fake-secret-key');`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: { HOME: dir }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
});

test("operations pin bucket ownership, use private encrypted writes, and preserve streaming AWS responses", async t => {
  const response = { VersionId: "test-version", ServerSideEncryption: "AES256", Body: Readable.from(["test"]) };
  const { storage, calls } = mockedStorage(t, response);
  assert.equal(await storage.check(), response);
  assert.equal(await storage.put("uploads/example.bin", Buffer.from("test")), response);
  assert.equal(await storage.get("uploads/example.bin"), response);
  assert.equal(await storage.remove("uploads/example.bin", { versionId: "test-version" }), response);
  assert.deepEqual(calls.map(c => c.command.constructor.name), ["HeadBucketCommand", "PutObjectCommand", "GetObjectCommand", "DeleteObjectCommand"]);
  for (const call of calls) {
    assert.equal(call.command.input.Bucket, config.bucket);
    assert.equal(call.command.input.ExpectedBucketOwner, config.accountId);
    assert.equal(call.options.abortSignal.aborted, false);
  }
  assert.equal(calls[1].command.input.ServerSideEncryption, "AES256");
  assert.equal(calls[1].command.input.ContentType, "application/octet-stream");
  assert.equal(calls[1].command.input.ContentLength, 4);
  assert.equal(calls[1].command.input.IfNoneMatch, "*");
  assert.equal(calls[1].command.input.ACL, undefined);
  assert.equal(calls[3].command.input.VersionId, "test-version");
  assert.equal(JSON.stringify(storage), "{}");
  assert.ok(!inspect(storage, { showHidden: true }).includes(saved.AWS_SECRET_ACCESS_KEY));
});

test("uploads support sized streams and explicit overwrites while rejecting mismatched lengths", async t => {
  const { storage, calls } = mockedStorage(t);
  const stream = Readable.from(["file-body"]);
  await storage.put("uploads/stream", stream, { contentType: "text/plain", contentLength: 9, overwrite: true });
  assert.equal(calls[0].command.input.Body, stream);
  assert.equal(calls[0].command.input.ContentLength, 9);
  assert.equal(calls[0].command.input.ContentType, "text/plain");
  assert.equal(calls[0].command.input.IfNoneMatch, undefined);
  await storage.put("uploads/unicode", "á");
  assert.equal(calls[1].command.input.ContentLength, 2);
  for (const length of [-1, 1.2, "4", NaN, Number.MAX_SAFE_INTEGER + 1, 3])
    assert.throws(() => storage.put("uploads/buffer", Buffer.from("test"), { contentLength: length }), /content length is invalid/);
  assert.throws(() => storage.put("uploads/buffer", "test", { overwrite: "true" }), /overwrite option/);
  assert.throws(() => storage.put("uploads/buffer", "test", { contentType: "text/plain\r\nOther: header" }), /content type/);
  assert.equal(calls.length, 2);
});

test("all key-taking operations reject unsafe keys and apply the UTF-8 byte limit", async t => {
  const { storage, calls } = mockedStorage(t);
  for (const key of ["", "/root", ".", "..", "a/./b", "a/../b", "a\\b", "a\0b", "a\x7fb", "a\u0085b", "x".repeat(1025), "é".repeat(513), null]) {
    assert.throws(() => storage.put(key, "test"), /object key is invalid/);
    assert.throws(() => storage.get(key), /object key is invalid/);
    assert.throws(() => storage.remove(key), /object key is invalid/);
  }
  assert.equal(calls.length, 0);
  await storage.put("é".repeat(512), Buffer.alloc(0));
  assert.equal(calls[0].command.input.ContentLength, 0);
});

test("SDK failures expose only safe operation, status and allowlisted code; close prevents requests", async () => {
  let destroyed = 0, requests = 0;
  const raw = Object.assign(new Error(`upstream: ${saved.AWS_SECRET_ACCESS_KEY}`), {
    name: "AccessDenied", $metadata: { httpStatusCode: 403 }, extraSecret: saved.AWS_SECRET_ACCESS_KEY,
  });
  const storage = new S3Storage(config, { client: {
    async send() { requests++; throw raw; }, destroy() { destroyed++; },
  } });
  await assert.rejects(() => storage.check(), error => {
    assert.equal(error.name, "StorageError");
    assert.equal(error.code, "AccessDenied");
    assert.equal(error.statusCode, 403);
    assert.equal(error.cause, undefined);
    assert.ok(!inspect(error).includes(saved.AWS_SECRET_ACCESS_KEY));
    return true;
  });
  raw.name = saved.AWS_SECRET_ACCESS_KEY;
  await assert.rejects(() => storage.check(), error => error.code === "StorageUnavailable" && !inspect(error).includes(saved.AWS_SECRET_ACCESS_KEY));
  storage.close(); storage.close();
  assert.equal(destroyed, 1);
  await assert.rejects(() => storage.check(), /storage is closed/);
  assert.equal(requests, 2);
});
