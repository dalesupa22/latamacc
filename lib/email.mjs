// Transactional mail only. Credentials stay in a private server-side file.
import { constants, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API_URL = "https://api.brevo.com/v3/smtp/email";
const HOUR = 3600_000, DAY = 24 * HOUR;
const DEFAULTS = { minIntervalMs: 2000, maxPerHour: 20, maxPerDay: 100, maxPerRecipientPerDay: 3, maxAttempts: 4, timeoutMs: 10_000, maxAgeMs: 2 * DAY };
const emailOk = value => typeof value === "string" && value.length <= 120 && !/\p{Cc}/u.test(value) && /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(value);
const textOk = value => typeof value === "string" && value.trim() && !/\p{Cc}/u.test(value);
const configurationError = () => new Error("Brevo configuration unavailable.");

export function loadBrevoConfig({ file, env = process.env } = {}) {
  if (env.BREVO_ENABLED === "0") return null;
  const path = file ?? env.BREVO_CONFIG_FILE ?? join(homedir(), ".config/latamacc/brevo.json");
  let descriptor, saved;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || (metadata.mode & 0o7777) !== 0o600) throw configurationError();
    saved = JSON.parse(readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw configurationError();
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw configurationError();
  if (saved.enabled === false) return null;
  const config = {
    apiKey: saved.apiKey, fromEmail: saved.fromEmail ?? "danny@latamacc.si", fromName: saved.fromName ?? "LATAMACC",
    replyToEmail: saved.replyToEmail ?? saved.fromEmail ?? "danny@latamacc.si",
    ...Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, saved[key] ?? value])),
  };
  if (!textOk(config.apiKey) || config.apiKey.length > 1024 || !textOk(config.fromName) || config.fromName.length > 120 ||
      ![config.fromEmail, config.replyToEmail].every(value => emailOk(value) && value.toLowerCase().endsWith("@latamacc.si")))
    throw configurationError();
  const ranges = { minIntervalMs: [1000, HOUR], maxPerHour: [1, 1000], maxPerDay: [1, 10_000], maxPerRecipientPerDay: [1, 10], maxAttempts: [1, 5], timeoutMs: [1000, 30_000], maxAgeMs: [HOUR, 7 * DAY] };
  for (const [key, [min, max]] of Object.entries(ranges))
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) throw configurationError();
  return config;
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const ITEMS = { tee: "Black tee", "tee-white": "White tee", cap: "Black cap", "cap-navy": "Navy cap" };

export const SIGNIN_LINK = /^https:\/\/latamacc\.si\/#signin=[A-Za-z0-9_-]{43}$/;

export function renderTransactionalEmail(eventType, data) {
  let subject, paragraphs, link = null;
  if (eventType === "registered") {
    subject = "Your LATAMACC registration is confirmed";
    paragraphs = ["Your registration in the LATAMACC directory is confirmed.", "Your public profile is now part of the directory. Your email address is kept private.", "To edit your profile, switch it to a company or post jobs, choose \"Edit profile\" on latamacc.si and sign in with this email.", "You can reply to this email if you need help with your registration.", "If you did not register, no action is needed."];
  } else if (eventType === "login") {
    // The only link is our own sign-in URL with a random single-use token.
    if (typeof data.link !== "string" || !SIGNIN_LINK.test(data.link)) throw new Error("Invalid transactional email event.");
    subject = "Your LATAMACC sign-in link";
    paragraphs = ["Use this link to edit your profile or post jobs in the LATAMACC directory:", data.link,
      "The link works once and expires in 24 hours.", "If you did not request it, you can ignore this email."];
    link = data.link;
  } else if (eventType === "dm") {
    // Aviso sin el texto ni el nombre del remitente: el mensaje se lee dentro de latamacc.si.
    subject = "You have a new message on LATAMACC";
    paragraphs = ["A member of the LATAMACC directory sent you a direct message.",
      "To read it and reply, open latamacc.si, choose \"Edit profile\", sign in with this email and go to Messages.",
      "We only email you about the first unread message, so your inbox stays quiet."];
  } else if (eventType === "buy") {
    // Aviso sin datos del comprador (los ve el vendedor dentro de latamacc.si).
    subject = "Someone wants to buy from you on LATAMACC";
    paragraphs = ["A buyer used the \"Buy\" button on your LATAMACC profile and left their contact details.",
      "To see who it is and what they want, open latamacc.si, choose \"Edit profile\", sign in with this email and go to Buyers. Reach out to them soon.",
      "We only email you about the first new request until you check them, so your inbox stays quiet."];
  } else if (eventType === "reserved" || eventType === "paid") {
    if (!Object.hasOwn(ITEMS, data.item) || !Number.isInteger(data.qty) || data.qty < 1 || data.qty > 10 ||
        !/^(ONE|[MW]-(S|M|L|XL))$/.test(data.size)) throw new Error("Invalid transactional email event.");
    subject = eventType === "paid" ? "Your LATAMACC payment is confirmed" : "Your LATAMACC reservation is confirmed";
    paragraphs = [eventType === "paid" ? "We have verified payment for your LATAMACC order." : "We have saved your LATAMACC reservation. No payment has been collected.",
      `${data.qty} × ${ITEMS[data.item]} · ${data.size}.`,
      "We will contact you separately to confirm shipping and delivery. You can reply to this email with questions."];
    if (eventType === "reserved") paragraphs.push("If you did not place this order, no action is needed.");
  } else throw new Error("Invalid transactional email event.");
  // No names, profile URLs or other user-supplied prose become message content or links.
  const footer = "LATAMACC · https://latamacc.si";
  return {
    subject,
    textContent: `${paragraphs.join("\n\n")}\n\n${footer}`,
    htmlContent: `<!doctype html><html lang="en"><body>${paragraphs.map(p => p === link
      ? `<p><a href="${escapeHtml(p)}">Sign in to LATAMACC</a></p>` : `<p>${escapeHtml(p)}</p>`).join("")}<p>LATAMACC · <a href="https://latamacc.si">latamacc.si</a></p></body></html>`,
  };
}

function retryAfterMs(value, now) {
  if (!value) return 0;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, Math.min(DAY, milliseconds)) : 0;
}

export class BrevoMailer {
  #config;
  #fetch;
  constructor(config, { fetchFn = fetch } = {}) { this.#config = config; this.#fetch = fetchFn; }
  payload(eventType, data) {
    if (!emailOk(data.email)) throw new Error("Invalid transactional email recipient.");
    return {
      sender: { name: this.#config.fromName, email: this.#config.fromEmail },
      replyTo: { email: this.#config.replyToEmail },
      to: [{ email: data.email.toLowerCase(), contactPixelTrackingConsent: false }],
      ...renderTransactionalEmail(eventType, data),
      tags: ["latamacc-transactional", eventType],
    };
  }
  async send(payload) {
    let response;
    try {
      response = await this.#fetch(API_URL, {
        method: "POST", redirect: "error", headers: { "api-key": this.#config.apiKey, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(this.#config.timeoutMs),
      });
    } catch { return { status: "unknown", reason: "transport_unknown" }; }
    // A gateway/server failure can occur after acceptance. Without a durable provider
    // guarantee, retrying that response could send the same confirmation twice.
    if (response.status >= 500) return { status: "unknown", reason: "provider_5xx_unknown" };
    if (response.status === 429)
      return { status: "retry", reason: `provider_${response.status}`, retryAfterMs: retryAfterMs(response.headers.get("retry-after"), Date.now()) };
    if (!response.ok) return { status: "failed", reason: `provider_${response.status}` };
    try {
      const body = await response.json();
      if (!textOk(body.messageId) || body.messageId.length > 255) return { status: "unknown", reason: "receipt_unknown" };
      return { status: "sent", messageId: body.messageId };
    } catch { return { status: "unknown", reason: "receipt_unknown" }; }
  }
}

export class EmailOutbox {
  #db;
  #mailer;
  #config;
  #now;
  #onChange;
  #running = false;
  #stopped = true;
  #timer;

  constructor(db, mailer, { config, now = Date.now, onChange = () => {} } = {}) {
    this.#db = db; this.#mailer = mailer; this.#config = config; this.#now = now; this.#onChange = onChange;
    db.exec(`CREATE TABLE IF NOT EXISTS email_outbox (
      event_key TEXT PRIMARY KEY, recipient TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      message_id TEXT, last_error TEXT);
      CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(status,next_attempt_at);
      CREATE TABLE IF NOT EXISTS email_attempts (id INTEGER PRIMARY KEY, recipient TEXT NOT NULL, attempted_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS email_attempts_time ON email_attempts(attempted_at);
      CREATE INDEX IF NOT EXISTS email_attempts_recipient ON email_attempts(recipient,attempted_at);
      CREATE TABLE IF NOT EXISTS email_pacing (id INTEGER PRIMARY KEY CHECK(id=1), next_send_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO email_pacing(id,next_send_at) VALUES(1,0);`);
    // A crash may happen after Brevo accepts a message but before its receipt is saved.
    // Never replay such messages automatically, even after a provider idempotency TTL expires.
    if (db.prepare("UPDATE email_outbox SET status='unknown',last_error='interrupted_unknown',updated_at=? WHERE status='sending'").run(now()).changes)
      this.#onChange();
    if (db.prepare("DELETE FROM email_attempts WHERE attempted_at<=?").run(now() - DAY).changes) this.#onChange();
    db.prepare(`UPDATE email_outbox SET payload='{}' WHERE status<>'pending' AND event_key LIKE 'login:%' AND payload<>'{}'`).run();
  }

  get enabled() { return !!this.#mailer && !!this.#config; }

  enqueue(eventType, data) {
    if (!this.enabled) return false;
    if (typeof data.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(data.id)) throw new Error("Invalid transactional email event.");
    const payload = this.#mailer.payload(eventType, data), now = this.#now();
    const inserted = this.#db.prepare(`INSERT OR IGNORE INTO email_outbox
      (event_key,recipient,payload,created_at,next_attempt_at,updated_at) VALUES(?,?,?,?,?,?)`)
      .run(`${eventType}:${data.id}`, payload.to[0].email, JSON.stringify(payload), now, now, now).changes > 0;
    if (inserted) { this.#onChange(); this.#schedule(); }
    return inserted;
  }

  start() { if (!this.enabled || !this.#stopped) return; this.#stopped = false; this.#schedule(); }
  stop() { this.#stopped = true; clearTimeout(this.#timer); }

  #schedule() {
    if (this.#stopped || this.#running) return;
    clearTimeout(this.#timer);
    const due = this.#db.prepare("SELECT MIN(MIN(next_attempt_at,created_at+?)) AS at FROM email_outbox WHERE status='pending'").get(this.#config.maxAgeMs).at;
    if (due === null) return;
    const pace = this.#db.prepare("SELECT next_send_at AS at FROM email_pacing WHERE id=1").get().at;
    this.#timer = setTimeout(() => { void this.processOne().catch(() => {
      // Avoid printing exception objects, payloads or credentials.
      console.error("Transactional email processing unavailable.");
    }).finally(() => this.#schedule()); }, Math.min(2_147_483_647, Math.max(50, due - this.#now(), pace - this.#now())));
    this.#timer.unref();
  }

  #limitUntil(now, recipient) {
    let until = this.#db.prepare("SELECT next_send_at AS at FROM email_pacing WHERE id=1").get().at;
    for (const [window, maximum, address] of [
      [HOUR, this.#config.maxPerHour, null], [DAY, this.#config.maxPerDay, null], [DAY, this.#config.maxPerRecipientPerDay, recipient],
    ]) {
      const row = this.#db.prepare(`SELECT COUNT(*) AS n, MIN(attempted_at) AS oldest FROM email_attempts
        WHERE attempted_at > ? ${address === null ? "" : "AND recipient=?"}`).get(...(address === null ? [now - window] : [now - window, address]));
      if (row.n >= maximum) until = Math.max(until, row.oldest + window);
    }
    return until;
  }

  async processOne() {
    if (!this.enabled || this.#running) return false;
    const now = this.#now();
    const expired = this.#db.prepare(`UPDATE email_outbox SET status='expired',last_error='expired',
      payload=CASE WHEN event_key LIKE 'login:%' THEN '{}' ELSE payload END,updated_at=? WHERE status='pending' AND created_at<=?`)
      .run(now, now - this.#config.maxAgeMs).changes;
    // Sign-in links expire after 24 hours; never send a dead one.
    this.#db.prepare(`UPDATE email_outbox SET status='expired',last_error='expired',payload='{}',updated_at=? WHERE status='pending' AND event_key LIKE 'login:%' AND created_at<=?`)
      .run(now, now - DAY);
    const pruned = this.#db.prepare("DELETE FROM email_attempts WHERE attempted_at<=?").run(now - DAY).changes;
    if (expired || pruned) this.#onChange();
    const row = this.#db.prepare("SELECT * FROM email_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at,rowid LIMIT 1").get(now);
    if (!row) return false;
    const until = this.#limitUntil(now, row.recipient);
    if (until > now) {
      this.#db.prepare("UPDATE email_outbox SET next_attempt_at=? WHERE event_key=?").run(until, row.event_key);
      this.#onChange();
      return false;
    }
    this.#running = true;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.prepare("UPDATE email_outbox SET status='sending',attempts=attempts+1,updated_at=? WHERE event_key=?").run(now, row.event_key);
        this.#db.prepare("INSERT INTO email_attempts(recipient,attempted_at) VALUES(?,?)").run(row.recipient, now);
        this.#db.prepare("UPDATE email_pacing SET next_send_at=? WHERE id=1").run(now + this.#config.minIntervalMs);
        this.#db.exec("COMMIT");
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
      this.#onChange();
      let result;
      try { result = await this.#mailer.send(JSON.parse(row.payload)); }
      catch { result = { status: "unknown", reason: "transport_unknown" }; }
      const completedAt = this.#now(), attempts = row.attempts + 1;
      let status = result.status, next = completedAt;
      if (status === "retry") {
        status = attempts >= this.#config.maxAttempts ? "failed" : "pending";
        next += Math.max(result.retryAfterMs || 0, Math.min(15 * 60_000, 60_000 * (2 ** (attempts - 1))));
        this.#db.prepare("UPDATE email_pacing SET next_send_at=MAX(next_send_at,?) WHERE id=1").run(next);
      }
      this.#db.prepare("UPDATE email_outbox SET status=?,next_attempt_at=?,updated_at=?,message_id=?,last_error=? WHERE event_key=?")
        .run(status, next, completedAt, result.messageId || null, result.reason || null, row.event_key);
      // Sign-in links are credentials: keep them only while they may still be sent.
      if (status !== "pending") this.#db.prepare(`UPDATE email_outbox SET payload='{}' WHERE event_key=? AND event_key LIKE 'login:%'`).run(row.event_key);
      this.#onChange();
      return true;
    } finally { this.#running = false; }
  }
}
