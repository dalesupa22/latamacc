import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadBrevoConfig, BrevoMailer, EmailOutbox, renderTransactionalEmail } from "../lib/email.mjs";

const HOUR = 3600_000, DAY = 24 * HOUR;
const registration = (id = "new-builder", email = "builder@example.test") => ({ id, email, name: '<img src="https://evil.test"> https://evil.test' });

function fixture(t, overrides = {}, fetchFn = async () => Response.json({ messageId: "<accepted-test>" }, { status: 201 })) {
  const dir = mkdtempSync(join(tmpdir(), "latamacc-email-test-")), file = join(dir, "brevo.json"), dbFile = join(dir, "mail.db");
  writeFileSync(file, JSON.stringify({ apiKey: "fake-brevo-secret", ...overrides }), { mode: 0o600 });
  const config = loadBrevoConfig({ file, env: {} }), calls = [];
  let now = 1_800_000_000_000, db = new DatabaseSync(dbFile), box;
  const mailer = new BrevoMailer(config, { fetchFn: async (...args) => { calls.push(args); return fetchFn(...args); } });
  const reopen = () => {
    if (box) { box.stop(); db.close(); db = new DatabaseSync(dbFile); }
    box = new EmailOutbox(db, mailer, { config, now: () => now });
    return box;
  };
  reopen();
  t.after(() => { box.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, config, calls, mailer, reopen, get db() { return db; }, get box() { return box; },
    time: () => now, advance: ms => { now += ms; }, row: key => db.prepare("SELECT * FROM email_outbox WHERE event_key=?").get(key) };
}

test("private configuration has LATAMACC defaults and explicit disable prevents reading any file", t => {
  const f = fixture(t);
  assert.equal(f.config.fromEmail, "danny@latamacc.si");
  assert.equal(f.config.replyToEmail, "danny@latamacc.si");
  assert.equal(f.config.fromName, "LATAMACC");
  assert.equal(f.config.maxPerHour, 20);
  assert.equal(f.config.maxPerDay, 100);
  assert.equal(loadBrevoConfig({ file: f.dir, env: { BREVO_ENABLED: "0" } }), null);
  assert.equal(loadBrevoConfig({ file: join(f.dir, "missing"), env: {} }), null);
  const key = f.config.apiKey;
  assert.ok(!JSON.stringify(f.mailer).includes(key));
  writeFileSync(f.file, JSON.stringify({ enabled: false }));
  assert.equal(loadBrevoConfig({ file: f.file, env: {} }), null);
});

test("configuration rejects symlinks, permissive files and invalid inputs without printing their contents", t => {
  const f = fixture(t);
  const bad = () => assert.throws(() => loadBrevoConfig({ file: f.file, env: {} }), error => error.message === "Brevo configuration unavailable.");
  chmodSync(f.file, 0o644); bad(); chmodSync(f.file, 0o600);
  symlinkSync(f.file, join(f.dir, "link"));
  assert.throws(() => loadBrevoConfig({ file: join(f.dir, "link"), env: {} }), /configuration unavailable/);
  for (const patch of [{ fromEmail: "admin@xertify.co" }, { replyToEmail: "bad\n@latamacc.si" }, { minIntervalMs: 0 },
    { maxPerHour: 0 }, { maxPerDay: 10001 }, { maxAttempts: 6 }, { timeoutMs: -1 }, { apiKey: "\r\nsecret" }]) {
    writeFileSync(f.file, JSON.stringify({ apiKey: "fake-secret", ...patch })); bad();
  }
  for (const raw of ['{"apiKey":"secret-fragment",', "null", "[]"]) { writeFileSync(f.file, raw); bad(); }
});

test("messages are transactional, contain equivalent plain text and simple HTML, and exclude user profile content", t => {
  const f = fixture(t);
  const payload = f.mailer.payload("registered", registration());
  assert.throws(() => f.mailer.payload("registered", registration("bad", "a\u0000@example.test")), /recipient/);
  assert.deepEqual(payload.to, [{ email: "builder@example.test", contactPixelTrackingConsent: false }]);
  assert.deepEqual(payload.sender, { name: "LATAMACC", email: "danny@latamacc.si" });
  assert.equal(payload.replyTo.email, "danny@latamacc.si");
  assert.ok(!JSON.stringify(payload).includes("evil.test"));
  assert.ok(!/<img|<script|<style/i.test(payload.htmlContent));
  assert.equal((payload.htmlContent.match(/href=/g) || []).length, 1);
  assert.ok(payload.textContent.includes("https://latamacc.si"));
  const reserved = renderTransactionalEmail("reserved", { item: "tee", size: "M-L", qty: 2 });
  assert.ok(reserved.textContent.includes("No payment has been collected."));
  assert.ok(reserved.htmlContent.includes("No payment has been collected."));
  assert.ok(renderTransactionalEmail("paid", { item: "cap", size: "ONE", qty: 1 }).textContent.includes("verified payment"));
  for (const event of ["campaign", "checkout", "anything"])
    assert.throws(() => renderTransactionalEmail(event, {}), /Invalid transactional/);
  assert.throws(() => renderTransactionalEmail("paid", { item: "<script>", size: "ONE", qty: 1 }), /Invalid transactional/);
});

test("transport pins HTTPS endpoint, bounds requests, and never forwards provider error bodies", async t => {
  let response = Response.json({ messageId: "<accepted>" }, { status: 201 });
  const f = fixture(t, {}, async () => response), payload = f.mailer.payload("registered", registration());
  assert.deepEqual(await f.mailer.send(payload), { status: "sent", messageId: "<accepted>" });
  const [url, options] = f.calls[0];
  assert.equal(url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(options.redirect, "error");
  assert.equal(options.method, "POST");
  assert.equal(options.headers["api-key"], "fake-brevo-secret");
  assert.equal(options.signal.aborted, false);
  for (const status of [400, 401, 403, 422]) {
    response = Response.json({ message: "fake-brevo-secret" }, { status });
    assert.deepEqual(await f.mailer.send(payload), { status: "failed", reason: `provider_${status}` });
  }
  response = Response.json({ message: "secret" }, { status: 429, headers: { "retry-after": "120" } });
  assert.deepEqual(await f.mailer.send(payload), { status: "retry", reason: "provider_429", retryAfterMs: 120_000 });
  response = Response.json({}, { status: 503 });
  assert.deepEqual(await f.mailer.send(payload), { status: "unknown", reason: "provider_5xx_unknown" });
  response = Response.json({}, { status: 201 });
  assert.equal((await f.mailer.send(payload)).status, "unknown");
  response = Response.json({ messageId: "" }, { status: 201 });
  assert.equal((await f.mailer.send(payload)).status, "unknown");
  const broken = new BrevoMailer(f.config, { fetchFn: async () => { throw new Error("raw secret timeout"); } });
  assert.deepEqual(await broken.send(payload), { status: "unknown", reason: "transport_unknown" });
});

test("outbox persists event dedupe across restart and never discovers historical registrations", async t => {
  const f = fixture(t);
  f.db.exec("CREATE TABLE builders(id TEXT,email TEXT); INSERT INTO builders VALUES('historical','old@example.test')");
  f.reopen();
  assert.equal(await f.box.processOne(), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.box.enqueue("registered", registration()), true);
  assert.equal(f.box.enqueue("registered", registration()), false);
  f.reopen();
  assert.equal(await f.box.processOne(), true);
  assert.equal(f.row("registered:new-builder").status, "sent");
  f.reopen();
  assert.equal(f.box.enqueue("registered", registration()), false);
  assert.equal(await f.box.processOne(), false);
  assert.equal(f.calls.length, 1);
});

test("disabled integration neither queues nor sends mail", async t => {
  const f = fixture(t), disabled = new EmailOutbox(f.db, null, { config: null });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.enqueue("registered", registration()), false);
  assert.equal(await disabled.processOne(), false);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM email_outbox").get().n, 0);
  assert.equal(f.calls.length, 0);
});

test("pacing and rolling hourly/daily caps survive restart without delaying the first message", async t => {
  const f = fixture(t, { maxPerHour: 2, maxPerDay: 3 });
  for (let i = 0; i < 4; i++) f.box.enqueue("registered", registration(`builder-${i}`, `builder${i}@example.test`));
  assert.equal(await f.box.processOne(), true);
  assert.equal(await f.box.processOne(), false);
  f.reopen();
  f.advance(2000); assert.equal(await f.box.processOne(), true);
  f.advance(2000); assert.equal(await f.box.processOne(), false);
  assert.equal(f.calls.length, 2);
  f.advance(HOUR); assert.equal(await f.box.processOne(), true);
  f.advance(2000); assert.equal(await f.box.processOne(), false);
  assert.equal(f.calls.length, 3);
  f.advance(DAY); assert.equal(await f.box.processOne(), true);
  assert.equal(f.calls.length, 4);
});

test("recipient cap delays excessive reservations while other recipients can proceed", async t => {
  const f = fixture(t, { maxPerRecipientPerDay: 1 });
  f.box.enqueue("registered", registration("first"));
  f.box.enqueue("registered", registration("second"));
  f.box.enqueue("registered", registration("third", "another@example.test"));
  await f.box.processOne(); f.advance(2000);
  assert.equal(await f.box.processOne(), false);
  assert.equal(f.row("registered:second").next_attempt_at, f.time() - 2000 + DAY);
  assert.equal(await f.box.processOne(), true);
  assert.equal(f.calls.length, 2);
});

test("429 backs off with bounded attempts; permanent failures never loop", async t => {
  let status = 429;
  const f = fixture(t, { maxAttempts: 2 }, async () => Response.json({ secret: "do not store" }, { status, headers: { "retry-after": "120" } }));
  f.box.enqueue("registered", registration());
  assert.equal(await f.box.processOne(), true);
  assert.equal(f.row("registered:new-builder").status, "pending");
  assert.equal(f.row("registered:new-builder").next_attempt_at, f.time() + 120_000);
  f.advance(119_000); assert.equal(await f.box.processOne(), false);
  f.advance(1000); assert.equal(await f.box.processOne(), true);
  assert.equal(f.row("registered:new-builder").status, "failed");
  f.advance(DAY); assert.equal(await f.box.processOne(), false);
  status = 400; f.box.enqueue("registered", registration("permanent"));
  await f.box.processOne(); f.advance(DAY);
  assert.equal(f.row("registered:permanent").status, "failed");
  assert.equal(await f.box.processOne(), false);
  assert.equal(f.calls.length, 3);
  assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM email_outbox").all()).includes("do not store"));
});

test("unknown transport outcomes and interrupted sends are never retried after restart", async t => {
  const f = fixture(t, {}, async () => { throw new Error("network timeout with raw secret"); });
  f.box.enqueue("registered", registration());
  await f.box.processOne();
  assert.equal(f.row("registered:new-builder").status, "unknown");
  f.box.enqueue("registered", registration("interrupted"));
  f.db.prepare("UPDATE email_outbox SET status='sending' WHERE event_key=?").run("registered:interrupted");
  f.reopen(); f.advance(DAY);
  assert.equal(f.row("registered:interrupted").status, "unknown");
  assert.equal(await f.box.processOne(), false);
  assert.equal(f.calls.length, 1);
});

test("5xx may follow provider acceptance and is not retried, including after restart", async t => {
  const f = fixture(t, {}, async () => Response.json({ message: "provider accepted then gateway failed" }, { status: 504 }));
  f.box.enqueue("registered", registration());
  await f.box.processOne();
  assert.equal(f.row("registered:new-builder").status, "unknown");
  assert.equal(f.row("registered:new-builder").last_error, "provider_5xx_unknown");
  f.reopen(); f.advance(DAY);
  assert.equal(await f.box.processOne(), false);
  assert.equal(f.calls.length, 1);
});

test("serial processor prevents overlapping sends while enqueue remains synchronous", async t => {
  let finish;
  const f = fixture(t, {}, () => new Promise(resolve => { finish = resolve; }));
  f.box.enqueue("registered", registration());
  const sending = f.box.processOne();
  f.box.enqueue("registered", registration("second"));
  assert.equal(f.row("registered:second").status, "pending");
  assert.equal(await f.box.processOne(), false);
  assert.equal(f.calls.length, 1);
  finish(Response.json({ messageId: "<accepted>" }, { status: 201 }));
  await sending;
});

test("pending confirmations expire and attempt recipient history is pruned after 24 hours", async t => {
  const f = fixture(t, { maxAgeMs: HOUR });
  f.box.enqueue("registered", registration("first"));
  await f.box.processOne();
  f.box.enqueue("registered", registration("stale"));
  f.advance(HOUR);
  assert.equal(await f.box.processOne(), false);
  assert.equal(f.row("registered:stale").status, "expired");
  assert.equal(f.calls.length, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM email_attempts").get().n, 1);
  f.advance(DAY); f.reopen();
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM email_attempts").get().n, 0);
  assert.equal(await f.box.processOne(), false);
});
