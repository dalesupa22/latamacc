// Servidor de latamacc.si: estáticos, directorio de builders/empresas de IA y WebSocket en vivo.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { mkdirSync, readFileSync, readdirSync, rmSync, chmodSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { randomUUID, randomBytes, createHmac, createHash, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";
import { loadMoonpayConfig, MoonpayCommerce, USD_ID, validateCharge, verifyWebhook } from "./lib/moonpay.mjs";
import { loadStorageConfig, S3Storage } from "./lib/storage.mjs";
import { loadBrevoConfig, BrevoMailer, EmailOutbox } from "./lib/email.mjs";
import { findMatches } from "./lib/matching.mjs";
import { bountyQuote, parseRewardUsd, usdToMinor, solanaAddressOk, FEE_BPS, MIN_FEE_USD, MIN_REWARD_USD, MAX_REWARD_USD } from "./lib/payrails.mjs";

const ROOT = new URL(".", import.meta.url).pathname;
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || "127.0.0.1";
const STORAGE = (() => {
  try { const config = loadStorageConfig(); return config ? new S3Storage(config) : null; }
  catch { console.error("S3 configuration unavailable."); return null; }
})();

const COUNTRIES = new Set(
  JSON.parse(readFileSync(join(PUBLIC, "assets/latam.json"), "utf8")).countries.filter(c => !c.deco).map(c => c.code)
);

const DATA = process.env.DATA_DIR || join(ROOT, "data"), BACKUPS = join(DATA, "backups"), DB_FILE = join(DATA, "latamacc.db");
mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
chmodSync(DATA, 0o700);
const db = new DatabaseSync(DB_FILE);
// WAL aguanta lecturas y escrituras a la vez; el archivo tiene correos, así que solo lo lee este usuario.
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
db.exec(`CREATE TABLE IF NOT EXISTS builders (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, country TEXT NOT NULL,
  city TEXT, building TEXT, handle TEXT, ip TEXT, created_at INTEGER NOT NULL)`);
// Columnas del directorio (migración en caliente para bases existentes).
const cols = new Set(db.prepare("PRAGMA table_info(builders)").all().map(c => c.name));
// also: otros países donde también construye (nómadas), como arreglo JSON de códigos.
// avatar: clave en S3 de la foto o logo; updated_at: última edición del perfil.
// offer/seeking: qué ofrece y qué o a quién busca (agente de networking); brochure: clave en S3 de su PDF.
for (const [col, def] of [["kind", "TEXT NOT NULL DEFAULT 'person'"], ["company", "TEXT"], ["website", "TEXT"], ["also", "TEXT NOT NULL DEFAULT '[]'"],
  ["avatar", "TEXT"], ["updated_at", "INTEGER"], ["referred_by", "TEXT"], ["calls", "TEXT"], ["offer", "TEXT"], ["seeking", "TEXT"], ["brochure", "TEXT"]])
  if (!cols.has(col)) db.exec(`ALTER TABLE builders ADD COLUMN ${col} ${def}`);
// Empleos publicados por miembros; vencen a los 60 días o cuando su autor los cierra.
db.exec(`CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, builder_id TEXT NOT NULL, title TEXT NOT NULL, company TEXT, country TEXT, city TEXT,
  workplace TEXT NOT NULL, type TEXT NOT NULL, salary TEXT, description TEXT, apply TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, closed_at INTEGER);
  CREATE INDEX IF NOT EXISTS jobs_builder ON jobs(builder_id);
  CREATE INDEX IF NOT EXISTS jobs_open ON jobs(closed_at, expires_at);`);
// Bounties: recompensas que publica un miembro (intros de ventas, producto, contenido). La recompensa la paga
// directamente quien publica a quien entrega; vencen en su fecha límite o cuando su autor las cierra.
db.exec(`CREATE TABLE IF NOT EXISTS bounties (
  id TEXT PRIMARY KEY, builder_id TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, reward TEXT NOT NULL,
  description TEXT, submit TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, closed_at INTEGER);
  CREATE INDEX IF NOT EXISTS bounties_builder ON bounties(builder_id);
  CREATE INDEX IF NOT EXISTS bounties_open ON bounties(closed_at, expires_at);`);
// reward_usd: recompensa en USD enteros cuando el bounty se puede depositar en escrow (lib/payrails.mjs).
if (!db.prepare("PRAGMA table_info(bounties)").all().some(c => c.name === "reward_usd")) db.exec("ALTER TABLE bounties ADD COLUMN reward_usd INTEGER");
// Depósitos en escrow de bounties: recompensa + comisión cobradas con MoonPay a la wallet de LATAMACC.
// Las filas no se borran (son el libro de lo que LATAMACC custodia y paga); title guarda el título al depositar.
db.exec(`CREATE TABLE IF NOT EXISTS bounty_funds (
  id TEXT PRIMARY KEY, bounty_id TEXT NOT NULL, builder_id TEXT NOT NULL, title TEXT NOT NULL,
  reward_usd INTEGER NOT NULL, fee_usd INTEGER NOT NULL, total_usd INTEGER NOT NULL,
  payment_amount TEXT NOT NULL, payment_currency TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
  charge_token TEXT UNIQUE, charge_id TEXT, checkout_url TEXT, expires_at INTEGER,
  payment_tx_id TEXT UNIQUE, payment_signature TEXT, paid_at INTEGER,
  winner_name TEXT, winner_wallet TEXT, awarded_at INTEGER, settle_signature TEXT, settled_at INTEGER, note TEXT);
  CREATE INDEX IF NOT EXISTS bounty_funds_bounty ON bounty_funds(bounty_id, created_at);
  CREATE INDEX IF NOT EXISTS bounty_funds_builder ON bounty_funds(builder_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS bounty_funds_one_checkout ON bounty_funds(bounty_id) WHERE status = 'awaiting_payment';`);
// Acceso de miembros sin contraseña: enlace por correo (un uso, 24 h) que se canjea por una sesión (30 días).
// Solo se guarda el hash SHA-256 de cada token.
db.exec(`CREATE TABLE IF NOT EXISTS member_tokens (
  hash TEXT PRIMARY KEY, builder_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS member_tokens_builder ON member_tokens(builder_id);`);
// Mensajes directos entre miembros. dm_blocks: a quién bloqueó cada miembro (no le pueden escribir).
db.exec(`CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
  CREATE INDEX IF NOT EXISTS messages_pair ON messages(from_id, to_id, created_at);
  CREATE INDEX IF NOT EXISTS messages_to ON messages(to_id, read_at);
  CREATE TABLE IF NOT EXISTS dm_blocks (builder_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (builder_id, blocked_id));`);
const HIRING = `(SELECT COUNT(*) FROM jobs WHERE jobs.builder_id = builders.id AND jobs.closed_at IS NULL AND jobs.expires_at > unixepoch() * 1000) AS hiring`;
const insert = db.prepare(`INSERT INTO builders (id,kind,name,company,email,country,also,city,building,website,handle,ip,created_at,referred_by,calls) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const directoryQ = db.prepare(`SELECT rowid AS n, *, ${HIRING} FROM builders
  WHERE (:country = '' OR country = :country OR EXISTS (SELECT 1 FROM json_each(builders.also) j WHERE j.value = :country))
    AND (:kind = '' OR kind = :kind)
    AND (:q = '' OR name LIKE :like OR company LIKE :like OR building LIKE :like OR city LIKE :like OR offer LIKE :like OR seeking LIKE :like)
    AND (:calls = 0 OR COALESCE(calls, '') <> '')
  ORDER BY created_at DESC LIMIT 60 OFFSET :offset`);
const directoryCountQ = db.prepare(`SELECT COUNT(*) n FROM builders
  WHERE (:country = '' OR country = :country OR EXISTS (SELECT 1 FROM json_each(builders.also) j WHERE j.value = :country))
    AND (:kind = '' OR kind = :kind)
    AND (:q = '' OR name LIKE :like OR company LIKE :like OR building LIKE :like OR city LIKE :like OR offer LIKE :like OR seeking LIKE :like)
    AND (:calls = 0 OR COALESCE(calls, '') <> '')`);
const byEmail = db.prepare(`SELECT rowid AS n, * FROM builders WHERE email = ?`);
const byId = db.prepare(`SELECT rowid AS n, *, ${HIRING} FROM builders WHERE id = ?`);
const recentQ = db.prepare(`SELECT rowid AS n, *, ${HIRING} FROM builders ORDER BY created_at DESC LIMIT 30`);
const numberQ = db.prepare(`SELECT rowid AS n FROM builders WHERE id = ?`);
const pointsQ = db.prepare(`SELECT id, kind, name, city, country, also, created_at FROM builders ORDER BY created_at DESC LIMIT 5000`);
// un nómada cuenta en cada país donde construye
const countsQ = db.prepare(`SELECT c AS country, COUNT(*) n FROM (
  SELECT country c FROM builders UNION ALL SELECT j.value FROM builders, json_each(builders.also) j) GROUP BY c`);
// crecimiento: registros por día, en hora de Bogotá
const kindsQ = db.prepare(`SELECT kind, COUNT(*) n FROM builders GROUP BY kind`);
const growthQ = db.prepare(`SELECT date(created_at / 1000, 'unixepoch', '-5 hours') d, COUNT(*) n FROM builders GROUP BY d ORDER BY d`);
const totalQ = db.prepare(`SELECT COUNT(*) n FROM builders`);
// Reservas y cobros: las credenciales y el estado de pago permanecen en el servidor.
db.exec(`CREATE TABLE IF NOT EXISTS merch_orders (
  id TEXT PRIMARY KEY, item TEXT NOT NULL, size TEXT NOT NULL, qty INTEGER NOT NULL, name TEXT, email TEXT NOT NULL,
  country TEXT, ip TEXT, created_at INTEGER NOT NULL)`);
const orderColumns = new Set(db.prepare("PRAGMA table_info(merch_orders)").all().map(c => c.name));
for (const [column, definition] of [
  ["status", "TEXT NOT NULL DEFAULT 'reserved'"], ["total_cents", "INTEGER"],
  ["payment_amount", "TEXT"], ["payment_currency", "TEXT"], ["status_token", "TEXT"],
  ["charge_token", "TEXT"], ["charge_id", "TEXT"], ["checkout_url", "TEXT"], ["expires_at", "INTEGER"],
  ["payment_tx_id", "TEXT"], ["payment_signature", "TEXT"], ["paid_at", "INTEGER"],
]) if (!orderColumns.has(column)) db.exec(`ALTER TABLE merch_orders ADD COLUMN ${column} ${definition}`);
for (const column of ["status_token", "charge_token", "payment_tx_id"])
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS merch_${column}_unique ON merch_orders(${column})`);
const insertOrder = db.prepare(`INSERT INTO merch_orders (id,item,size,qty,name,email,country,ip,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
const orderByStatus = db.prepare("SELECT * FROM merch_orders WHERE status_token = ?");
const orderByCharge = db.prepare("SELECT * FROM merch_orders WHERE charge_token = ?");
const orderByTransaction = db.prepare("SELECT id FROM merch_orders WHERE payment_tx_id = ?");
const startPayment = db.prepare(`UPDATE merch_orders SET status = 'awaiting_payment', total_cents = ?,
  payment_amount = ?, payment_currency = ?, status_token = ? WHERE id = ?`);
const attachCharge = db.prepare(`UPDATE merch_orders SET charge_token = ?, charge_id = ?, checkout_url = ?, expires_at = ? WHERE id = ?`);
const paymentStatus = db.prepare("UPDATE merch_orders SET status = ? WHERE id = ? AND status <> 'paid'");
const confirmPayment = db.prepare(`UPDATE merch_orders SET status = 'paid', payment_tx_id = ?, payment_signature = ?, paid_at = ? WHERE id = ? AND status <> 'paid'`);
const ordersQ = db.prepare(`SELECT COUNT(*) n FROM merch_orders`);
// Corte hombre (M) o mujer (W) + talla, p. ej. "W-L". pay: cobro con MoonPay cuando está configurado.
const TEE_SIZES = ["M", "W"].flatMap(f => ["S", "M", "L", "XL"].map(z => `${f}-${z}`));
const MERCH = {
  tee: { price: 49, sizes: TEE_SIZES, pay: true },         // camiseta negra
  "tee-white": { price: 49, sizes: TEE_SIZES, pay: true },
  cap: { price: 49, sizes: ["ONE"], pay: true },           // gorra negra
  "cap-navy": { price: 49, sizes: ["ONE"], pay: true },
};
const MOONPAY_CONFIG = loadMoonpayConfig();
const MOONPAY = MOONPAY_CONFIG ? new MoonpayCommerce(MOONPAY_CONFIG) : null;
const merchPayments = () => Object.fromEntries(Object.entries(MERCH).map(([k, m]) => [k, !!MOONPAY && !!m.pay]));

// Anti-bots: token firmado que se entrega al cargar la página. Un envío sin token, o hecho en menos de
// 3 s, no viene de una persona usando el formulario. Turnstile se suma cuando hay claves configuradas.
const SECRET_FILE = join(DATA, "form-secret");
if (!existsSync(SECRET_FILE)) writeFileSync(SECRET_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
const FORM_SECRET = readFileSync(SECRET_FILE, "utf8").trim();
const sign = ts => createHmac("sha256", FORM_SECRET).update(String(ts)).digest("hex").slice(0, 32);
const formToken = () => { const ts = Date.now(); return `${ts}.${sign(ts)}`; };
function formTokenOk(token) {
  const [ts, mac] = String(token || "").split(".");
  const age = Date.now() - Number(ts);
  if (!mac || mac.length !== 32 || !(age >= 3000 && age <= 6 * 3600_000)) return false;
  return timingSafeEqual(Buffer.from(mac), Buffer.from(sign(ts)));
}
const TURNSTILE = (() => {
  const file = process.env.TURNSTILE_FILE || join(process.env.HOME || "", ".config/latamacc/turnstile.json");
  try { const t = JSON.parse(readFileSync(file, "utf8")); return t.sitekey && t.secret ? t : null; } catch { return null; }
})();
async function humanCheck(b, ip) {
  if (b.hp_field) return "bot";
  if (!formTokenOk(b.ft)) return "Please reload the page and try again.";
  if (!TURNSTILE) return null;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body: new URLSearchParams({ secret: TURNSTILE.secret, response: String(b.turnstile || ""), remoteip: ip }),
    }).then(r => r.json());
    return r.success ? null : "Please complete the verification and try again.";
  } catch { return "Verification is unavailable, please try again."; }
}
for (const f of [DB_FILE, DB_FILE + "-wal", DB_FILE + "-shm"]) { try { chmodSync(f, 0o600); } catch {} }

// Copias de seguridad: una al arrancar y cada hora si hubo registros nuevos; se guardan las últimas 72.
let lastBackup = null, lastBackupTotal = "", dataRevision = 0;
function backup() {
  const total = `${totalQ.get().n}/${ordersQ.get().n}/${dataRevision}`;
  if (total === lastBackupTotal) return;
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 18);
  const file = join(BACKUPS, `latamacc-${stamp}.db`);
  try {
    db.exec(`VACUUM INTO '${file}'`);
    chmodSync(file, 0o600);
    lastBackup = { file, at: Date.now(), builders: totalQ.get().n, orders: ordersQ.get().n };
    lastBackupTotal = total;
    const all = readdirSync(BACKUPS).filter(f => f.endsWith(".db")).sort();
    for (const old of all.slice(0, -72)) rmSync(join(BACKUPS, old));
  } catch (e) { console.error("backup falló", file, e.message); }
}
backup();
setInterval(backup, 60 * 60_000);
// Además, respaldo 30 s después de cada escritura (agrupa ráfagas de registros).
let backupSoon;
const scheduleBackup = () => { dataRevision++; clearTimeout(backupSoon); backupSoon = setTimeout(backup, 30_000); };

const EMAIL_CONFIG = (() => {
  try { return loadBrevoConfig(); }
  catch { console.error("Brevo configuration unavailable."); return null; }
})();
const EMAIL = new EmailOutbox(db, EMAIL_CONFIG ? new BrevoMailer(EMAIL_CONFIG) : null,
  { config: EMAIL_CONFIG, onChange: scheduleBackup });
EMAIL.start();
function persistWithEmail(write) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = write();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// El correo no se expone públicamente; se transmite a Brevo para confirmaciones transaccionales.
function publicView(r) {
  const by = r.referred_by ? inviterQ.get(r.referred_by) : null;
  return { id: r.id, n: r.n, kind: r.kind || "person", name: r.name, company: r.company || "", country: r.country, city: r.city || "",
    also: alsoOf(r), building: r.building || "", website: r.website || "", handle: r.handle || "", ts: r.created_at,
    avatar: r.avatar ? `/media/${r.avatar}` : "", hiring: r.hiring || 0, calls: r.calls || "",
    offer: r.offer || "", seeking: r.seeking || "", brochure: r.brochure ? `/media/${r.brochure}` : "",
    ref: refOf(r.id), invitedBy: by ? { id: by.id, name: by.name, n: by.n } : null, invited: invitedCountQ.get(r.id).n };
}
// ---------- referidos: cada miembro invita con latamacc.si/?ref=<8 primeros caracteres de su id> ----------
const refOf = id => String(id).slice(0, 8);
const REF_RE = /^[0-9a-f]{8}$/;
const inviterQ = db.prepare("SELECT rowid AS n, id, name FROM builders WHERE id = ?");
const invitedCountQ = db.prepare("SELECT COUNT(*) n FROM builders WHERE referred_by = ?");
const byRefQ = db.prepare("SELECT rowid AS n, id, name, kind, country FROM builders WHERE substr(id, 1, 8) = ? ORDER BY created_at LIMIT 1");
const topInvitersQ = db.prepare(`SELECT b.rowid AS n, b.id, b.name, b.country, COUNT(*) invited FROM builders r JOIN builders b ON b.id = r.referred_by
  GROUP BY b.id ORDER BY invited DESC, MIN(r.created_at) LIMIT 5`);
const callsOpenQ = db.prepare("SELECT COUNT(*) n FROM builders WHERE COALESCE(calls, '') <> ''");
const networkReadyQ = db.prepare("SELECT COUNT(*) n FROM builders WHERE COALESCE(offer, '') <> '' OR COALESCE(seeking, '') <> ''");
const referredTotalQ = db.prepare("SELECT COUNT(*) n FROM builders WHERE referred_by IS NOT NULL");
const inviterOf = code => REF_RE.test(String(code || "")) ? byRefQ.get(String(code)) : null;
function alsoOf(r) { try { const a = JSON.parse(r.also || "[]"); return Array.isArray(a) ? a.filter(c => COUNTRIES.has(c)) : []; } catch { return []; } }
// hasta 4 países adicionales válidos, sin repetir el principal
function cleanAlso(v, primary) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return [...new Set(list.map(c => clean(String(c), 2).toUpperCase()))].filter(c => COUNTRIES.has(c) && c !== primary).slice(0, 4);
}

function state() {
  return {
    total: totalQ.get().n,
    byCountry: Object.fromEntries(countsQ.all().map(r => [r.country, r.n])),
    recent: recentQ.all().map(publicView),
    jobs: openJobsTotal.get(Date.now()).n,
    bounties: openBountiesTotal.get(Date.now()).n,
    editing: EMAIL.enabled, uploads: !!STORAGE,
    points: pointsQ.all().map(r => ({ id: r.id, kind: r.kind || "person", name: r.name, city: r.city || "", country: r.country, also: alsoOf(r), ts: r.created_at })),
    growth: growthQ.all().map(r => [r.d, r.n]),
    kinds: Object.fromEntries(kindsQ.all().map(r => [r.kind || "person", r.n])),
    referred: referredTotalQ.get().n,
    openToCalls: callsOpenQ.get().n,
    networkReady: networkReadyQ.get().n,
    topInviters: topInvitersQ.all().map(r => ({ id: r.id, n: r.n, name: r.name, country: r.country, invited: r.invited })),
    ...presence(),
    merchPayments: merchPayments(),
    bountyPayments: bountyPayments(),
  };
}

// Quién está mirando, por país (Cloudflare manda cf-ipcountry). Solo conteos agregados.
function presence() {
  const byCountry = {};
  for (const c of wss?.clients || []) if (c.cc) byCountry[c.cc] = (byCountry[c.cc] || 0) + 1;
  return { online: wss ? wss.clients.size : 0, watching: byCountry };
}

function health() {
  return { ok: true, builders: totalQ.get().n, dbBytes: statSync(DB_FILE).size, journal: db.prepare("PRAGMA journal_mode").get().journal_mode,
    lastBackup: lastBackup && { at: new Date(lastBackup.at).toISOString(), builders: lastBackup.builders, preorders: lastBackup.orders }, preorders: ordersQ.get().n,
    turnstile: !!TURNSTILE, moonpay: !!MOONPAY, s3: !!STORAGE, email: EMAIL.enabled, online: wss.clients.size };
}

const clean = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max) : "");

const hits = new Map();
function limited(ip, max = 20, windowMs = 60_000) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > max;
}

const clientIp = req => req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "";

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 4096) {
  return JSON.parse((await readRawBody(req, limit)).toString("utf8") || "{}");
}
async function readRawBody(req, limit = 4096) {
  let size = 0, chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error("too large"); chunks.push(c); }
  return Buffer.concat(chunks);
}

async function register(req, res) {
  const ip = clientIp(req);
  if (limited(ip)) return json(res, 429, { error: "Too many attempts, please wait a minute." });
  let b;
  try { b = await readBody(req); } catch { return json(res, 400, { error: "Invalid request." }); }
  const human = await humanCheck(b, ip);
  if (human === "bot") return json(res, 200, { ok: true });
  if (human) return json(res, 400, { error: human });
  const email = clean(b.email, 120).toLowerCase();
  const profile = parseProfile(b);
  if (profile.error) return json(res, 400, { error: profile.error });
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: "Invalid email." });

  const existing = byEmail.get(email);
  if (existing) return json(res, 200, { ok: true, existing: true, builder: publicView(existing), canEdit: EMAIL.enabled });

  const row = { id: randomUUID(), ...profile, email, ip, created_at: Date.now(), referred_by: inviterOf(b.ref)?.id || null };
  persistWithEmail(() => {
    insert.run(row.id, row.kind, row.name, row.company, row.email, row.country, row.also, row.city, row.building, row.website, row.handle, row.ip, row.created_at, row.referred_by, row.calls);
    EMAIL.enqueue("registered", row);
  });
  const pub = publicView({ ...row, n: numberQ.get(row.id).n });
  broadcast({ type: "join", builder: pub, total: totalQ.get().n });
  scheduleBackup();
  json(res, 201, { ok: true, builder: pub });
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Campos públicos del perfil, compartidos por el registro y la edición.
function parseProfile(b) {
  const name = clean(b.name, 60);
  const country = clean(b.country, 2).toUpperCase();
  const kind = b.kind === "company" ? "company" : "person";
  let website = clean(b.website, 120);
  if (website && !/^https?:\/\//i.test(website)) website = "https://" + website;
  try { if (website) { const u = new URL(website); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw 0; website = u.href; } }
  catch { return { error: "That website doesn't look right." }; }
  // enlace para agendar una llamada (Calendly, Cal.com, Google Calendar…), opcional
  let calls = clean(b.calls, 200);
  if (calls && !/^https?:\/\//i.test(calls)) calls = "https://" + calls;
  try { if (calls) { const u = new URL(calls); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw 0; calls = u.href; } }
  catch { return { error: "That booking link doesn't look right." }; }
  if (name.length < 2) return { error: kind === "company" ? "Add the company name." : "Add your name." };
  if (!COUNTRIES.has(country)) return { error: "Pick a Latam country." };
  return { kind, name, company: kind === "person" ? clean(b.company, 80) : "", country, also: JSON.stringify(cleanAlso(b.also, country)), website,
    city: clean(b.city, 60), building: clean(b.building, 140), handle: clean(b.handle, 30).replace(/^@/, ""), calls };
}

// ---------- miembros: enlace por correo, sesión, edición del perfil y foto/logo ----------
const HOUR = 3600_000, DAY = 24 * HOUR;
const tokenHash = t => createHash("sha256").update(String(t)).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const insertToken = db.prepare("INSERT INTO member_tokens (hash,builder_id,kind,created_at,expires_at) VALUES (?,?,?,?,?)");
const tokenQ = db.prepare("SELECT * FROM member_tokens WHERE hash = ? AND kind = ? AND expires_at > ?");
const dropToken = db.prepare("DELETE FROM member_tokens WHERE hash = ?");
const pruneTokens = db.prepare("DELETE FROM member_tokens WHERE expires_at <= ?");
const updateProfile = db.prepare(`UPDATE builders SET kind=?, name=?, company=?, country=?, also=?, city=?, building=?, website=?, handle=?, calls=?, updated_at=? WHERE id=?`);
const setAvatar = db.prepare("UPDATE builders SET avatar = ?, updated_at = ? WHERE id = ?");
setInterval(() => pruneTokens.run(Date.now()), HOUR).unref();

function sessionOf(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization || ""));
  const t = m && tokenQ.get(tokenHash(m[1]), "session", Date.now());
  return t ? byId.get(t.builder_id) || null : null;
}
const myJobsQ = db.prepare("SELECT * FROM jobs WHERE builder_id = ? AND closed_at IS NULL AND expires_at > ? ORDER BY created_at DESC");
const myBountiesQ = db.prepare(`SELECT x.*, (SELECT COUNT(*) FROM bounty_funds f WHERE f.bounty_id = x.id AND f.status = 'paid') AS escrow
  FROM bounties x WHERE builder_id = :id AND closed_at IS NULL
    AND (expires_at > :now OR EXISTS (SELECT 1 FROM bounty_funds f WHERE f.bounty_id = x.id AND f.status = 'paid'))
  ORDER BY created_at DESC`);
const me = r => ({ ...publicView(r), email: r.email, unread: unreadQ.get(r.id).n, jobs: myJobsQ.all(r.id, Date.now()).map(j => jobView(j, r)),
  // un bounty con depósito vencido sigue visible para su autor hasta elegir ganador o cerrarlo (reembolso)
  bounties: myBountiesQ.all({ id: r.id, now: Date.now() }).map(x => ({ ...bountyView(x, r), funding: fundingView(latestFund.get(x.id)) })),
  escrow: myFundsQ.all(r.id).map(fundingView) });

const loginLoad = email => db.prepare(`SELECT
  (SELECT COUNT(*) FROM email_attempts WHERE recipient = :email AND attempted_at > :since) +
  (SELECT COUNT(*) FROM email_outbox WHERE recipient = :email AND status = 'pending') AS n`).get({ email, since: Date.now() - DAY }).n;
async function requestLink(req, res) {
  const ip = clientIp(req);
  if (limited("link:" + ip, 5, 15 * 60_000)) return json(res, 429, { error: "Too many attempts, please wait a few minutes." });
  let b;
  try { b = await readBody(req); } catch { return json(res, 400, { error: "Invalid request." }); }
  const human = await humanCheck(b, ip);
  if (human === "bot") return json(res, 200, { ok: true });
  if (human) return json(res, 400, { error: human });
  const email = clean(b.email, 120).toLowerCase();
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: "Invalid email." });
  if (!EMAIL.enabled) return json(res, 503, { error: "Email sign-in is not available yet. Please try again soon." });
  const builder = byEmail.get(email);
  // La respuesta es la misma exista o no el correo, para no revelar quién está en el directorio.
  // Si ese correo ya alcanzó su cupo diario (enviados + en cola), no se encola otro enlace que llegaría horas después.
  if (builder && loginLoad(email) < (EMAIL_CONFIG?.maxPerRecipientPerDay ?? 3)) {
    const token = newToken(), now = Date.now();
    persistWithEmail(() => {
      insertToken.run(tokenHash(token), builder.id, "link", now, now + DAY);
      EMAIL.enqueue("login", { id: randomUUID(), email, link: `https://latamacc.si/#signin=${token}` });
    });
  }
  json(res, 200, { ok: true });
}

async function startSession(req, res) {
  if (limited("session:" + clientIp(req), 20)) return json(res, 429, { error: "Too many attempts, please wait a minute." });
  let b;
  try { b = await readBody(req); } catch { return json(res, 400, { error: "Invalid request." }); }
  const link = /^[A-Za-z0-9_-]{43}$/.test(b.token || "") && tokenQ.get(tokenHash(b.token), "link", Date.now());
  // un enlace se usa una sola vez
  if (!link || !dropToken.run(link.hash).changes) return json(res, 401, { error: "This sign-in link has expired or was already used. Request a new one." });
  const builder = byId.get(link.builder_id);
  if (!builder) return json(res, 401, { error: "This profile no longer exists." });
  const session = newToken(), now = Date.now();
  insertToken.run(tokenHash(session), builder.id, "session", now, now + 30 * DAY);
  json(res, 200, { ok: true, session, me: me(builder) });
}

async function saveProfile(req, res, builder) {
  if (limited("edit:" + builder.id, 30)) return json(res, 429, { error: "Too many changes, please wait a minute." });
  let b;
  try { b = await readBody(req); } catch { return json(res, 400, { error: "Invalid request." }); }
  const p = parseProfile(b);
  if (p.error) return json(res, 400, { error: p.error });
  updateProfile.run(p.kind, p.name, p.company, p.country, p.also, p.city, p.building, p.website, p.handle, p.calls, Date.now(), builder.id);
  scheduleBackup();
  const row = byId.get(builder.id);
  broadcast({ type: "update", builder: publicView(row) });
  json(res, 200, { ok: true, me: me(row) });
}

// Foto (persona) o logo (empresa): PNG, JPEG o WebP de hasta 1,5 MB, guardado en S3 privado y servido por /media.
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
function imageType(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}
async function uploadAvatar(req, res, builder) {
  if (!STORAGE) return json(res, 503, { error: "Photo uploads are not available right now." });
  if (limited("avatar:" + builder.id, 10)) return json(res, 429, { error: "Too many uploads, please wait a minute." });
  let buf;
  try { buf = await readRawBody(req, 1_572_864); } catch { return json(res, 413, { error: "The image must be 1.5 MB or less." }); }
  const ext = imageType(buf);
  if (!ext) return json(res, 400, { error: "Use a PNG, JPG or WebP image." });
  const key = `avatars/${builder.id}/${randomUUID()}.${ext}`;
  try { await STORAGE.put(key, buf, { contentType: IMAGE_TYPES[ext] }); }
  catch { return json(res, 502, { error: "Could not save the image. Please try again." }); }
  setAvatar.run(key, Date.now(), builder.id);
  scheduleBackup();
  if (builder.avatar) STORAGE.remove(builder.avatar).catch(() => {});
  const row = byId.get(builder.id);
  broadcast({ type: "update", builder: publicView(row) });
  json(res, 200, { ok: true, me: me(row) });
}
async function removeAvatar(res, builder) {
  setAvatar.run(null, Date.now(), builder.id);
  scheduleBackup();
  if (builder.avatar) STORAGE?.remove(builder.avatar).catch(() => {});
  const row = byId.get(builder.id);
  broadcast({ type: "update", builder: publicView(row) });
  json(res, 200, { ok: true, me: me(row) });
}
const MEDIA_RE = /^\/media\/((?:avatars\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|webp))|(?:brochures\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf)))$/;
// Solo se sirven archivos en uso: una foto o brochure reemplazado o quitado deja de verse aunque S3 no permita borrarlo.
const mediaInUse = db.prepare("SELECT 1 FROM builders WHERE avatar = :key OR brochure = :key");
const MEDIA_TYPES = { ...IMAGE_TYPES, pdf: "application/pdf" };
async function serveMedia(req, res, key, ext) {
  if (!STORAGE || !mediaInUse.get({ key })) return json(res, 404, { error: "not found" });
  let obj;
  try { obj = await STORAGE.get(key); }
  catch (e) { return json(res, e.code === "NoSuchKey" || e.statusCode === 404 || e.statusCode === 403 ? 404 : 502, { error: "not found" }); }
  // caché corta: al quitar una foto, Cloudflare deja de servirla en una hora como máximo
  res.writeHead(200, { "content-type": MEDIA_TYPES[ext], "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff",
    ...(ext === "pdf" ? { "content-disposition": "inline; filename=\"brochure.pdf\"", "content-security-policy": "sandbox" } : {}),
    ...(obj.ContentLength ? { "content-length": obj.ContentLength } : {}) });
  if (req.method === "HEAD") { obj.Body?.destroy?.(); return res.end(); }
  obj.Body.on("error", () => res.destroy()).pipe(res);
}

// ---------- agente de networking: qué ofrezco, qué busco, brochure y cruces ----------
const setNetwork = db.prepare("UPDATE builders SET offer = ?, seeking = ?, updated_at = ? WHERE id = ?");
const setBrochure = db.prepare("UPDATE builders SET brochure = ?, updated_at = ? WHERE id = ?");
const networkPoolQ = db.prepare(`SELECT rowid AS n, *, ${HIRING} FROM builders`);
async function saveNetwork(req, res, builder) {
  if (limited("edit:" + builder.id, 30)) return json(res, 429, { error: "Too many changes, please wait a minute." });
  let b;
  try { b = await readBody(req); } catch { return json(res, 400, { error: "Invalid request." }); }
  const offer = clean(b.offer, 400), seeking = clean(b.seeking, 400);
  setNetwork.run(offer, seeking, Date.now(), builder.id);
  scheduleBackup();
  const row = byId.get(builder.id);
  broadcast({ type: "update", builder: publicView(row) });
  json(res, 200, { ok: true, me: me(row) });
}
// Brochure en PDF de hasta 8 MB, guardado en S3 privado y servido por /media.
async function uploadBrochure(req, res, builder) {
  if (!STORAGE) return json(res, 503, { error: "Uploads are not available right now." });
  if (limited("brochure:" + builder.id, 10)) return json(res, 429, { error: "Too many uploads, please wait a minute." });
  let buf;
  try { buf = await readRawBody(req, 8 * 1024 * 1024); } catch { return json(res, 413, { error: "The brochure must be 8 MB or less." }); }
  if (buf.length < 5 || buf.toString("latin1", 0, 5) !== "%PDF-") return json(res, 400, { error: "Upload your brochure as a PDF." });
  const key = `brochures/${builder.id}/${randomUUID()}.pdf`;
  try { await STORAGE.put(key, buf, { contentType: "application/pdf" }); }
  catch { return json(res, 502, { error: "Could not save the brochure. Please try again." }); }
  setBrochure.run(key, Date.now(), builder.id);
  scheduleBackup();
  if (builder.brochure) STORAGE.remove(builder.brochure).catch(() => {});
  const row = byId.get(builder.id);
  broadcast({ type: "update", builder: publicView(row) });
  json(res, 200, { ok: true, me: me(row) });
}
function removeBrochure(res, builder) {
  setBrochure.run(null, Date.now(), builder.id);
  scheduleBackup();
  if (builder.brochure) STORAGE?.remove(builder.brochure).catch(() => {});
  const row = byId.get(builder.id);
  broadcast({ type: "update", builder: publicView(row) });
  json(res, 200, { ok: true, me: me(row) });
}
function networkMatches(res, builder) {
  if (limited("match:" + builder.id, 30)) return json(res, 429, { error: "Too many requests, please wait a minute." });
  if (!builder.seeking && !builder.offer) return json(res, 200, { ok: true, matches: [], needs: true });
  const pool = networkPoolQ.all(), byIdMap = new Map(pool.map(r => [r.id, r]));
  const matches = findMatches(builder, pool).map(m => ({ ...m, builder: publicView(byIdMap.get(m.id)) }));
  json(res, 200, { ok: true, matches });
}

// ---------- búsqueda global: personas y empresas, bounties y empleos ----------
const searchPeopleQ = db.prepare(`SELECT rowid AS n, *, ${HIRING} FROM builders
  WHERE name LIKE :like OR company LIKE :like OR building LIKE :like OR city LIKE :like OR offer LIKE :like OR seeking LIKE :like OR handle LIKE :like
  ORDER BY (name LIKE :like OR company LIKE :like) DESC, created_at DESC LIMIT 8`);
function search(res, q) {
  q = clean(q, 60);
  if (q.length < 2) return json(res, 200, { people: [], bounties: [], jobs: [] });
  const like = `%${q.replace(/[%_]/g, "")}%`, now = Date.now();
  json(res, 200, {
    people: searchPeopleQ.all({ like }).map(publicView),
    bounties: bountiesQ.all({ q, like, category: "", now, offset: 0 }).slice(0, 4).map(x => bountyView(x)),
    jobs: jobsQ.all({ q, like, country: "", workplace: "", type: "", now, offset: 0 }).slice(0, 4).map(j => jobView(j)),
  });
}

// ---------- mensajes directos ----------
const unreadQ = db.prepare("SELECT COUNT(*) n FROM messages WHERE to_id = ? AND read_at IS NULL");
const deleteMessagesOf = db.prepare("DELETE FROM messages WHERE from_id = ? OR to_id = ?");
const deleteBlocksOf = db.prepare("DELETE FROM dm_blocks WHERE builder_id = ? OR blocked_id = ?");
const insertMessage = db.prepare("INSERT INTO messages (id,from_id,to_id,body,created_at) VALUES (?,?,?,?,?)");
const threadQ = db.prepare(`SELECT * FROM messages WHERE (from_id = :a AND to_id = :b) OR (from_id = :b AND to_id = :a) ORDER BY created_at DESC LIMIT 200`);
const markRead = db.prepare("UPDATE messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL");
const inboxQ = db.prepare(`SELECT other, MAX(created_at) ts, SUM(CASE WHEN to_id = :me AND read_at IS NULL THEN 1 ELSE 0 END) unread,
    (SELECT body FROM messages m2 WHERE (m2.from_id = :me AND m2.to_id = other) OR (m2.from_id = other AND m2.to_id = :me) ORDER BY created_at DESC LIMIT 1) last,
    (SELECT from_id = :me FROM messages m2 WHERE (m2.from_id = :me AND m2.to_id = other) OR (m2.from_id = other AND m2.to_id = :me) ORDER BY created_at DESC LIMIT 1) mine
  FROM (SELECT CASE WHEN from_id = :me THEN to_id ELSE from_id END other, created_at, to_id, read_at FROM messages WHERE from_id = :me OR to_id = :me)
  GROUP BY other ORDER BY ts DESC LIMIT 100`);
const pairExists = db.prepare("SELECT 1 FROM messages WHERE (from_id = :a AND to_id = :b) OR (from_id = :b AND to_id = :a) LIMIT 1");
const newThreadsToday = db.prepare(`SELECT COUNT(DISTINCT to_id) n FROM messages m WHERE from_id = :me AND created_at > :since
  AND NOT EXISTS (SELECT 1 FROM messages p WHERE p.from_id = m.to_id AND p.to_id = :me)
  AND NOT EXISTS (SELECT 1 FROM messages p WHERE p.from_id = :me AND p.to_id = m.to_id AND p.created_at <= :since)`);
const blockedQ = db.prepare("SELECT 1 FROM dm_blocks WHERE builder_id = ? AND blocked_id = ?");
const addBlock = db.prepare("INSERT OR IGNORE INTO dm_blocks (builder_id, blocked_id, created_at) VALUES (?,?,?)");
const dropBlock = db.prepare("DELETE FROM dm_blocks WHERE builder_id = ? AND blocked_id = ?");
const MAX_NEW_THREADS_PER_DAY = 20;
const msgView = (m, meId) => ({ id: m.id, mine: m.from_id === meId, body: m.body, ts: m.created_at, read: !!m.read_at });
function inbox(res, builder) {
  const rows = inboxQ.all({ me: builder.id });
  const threads = rows.map(r => { const o = byId.get(r.other); return o && { with: publicView(o), ts: r.ts, unread: r.unread, last: r.last.slice(0, 140), mine: !!r.mine }; }).filter(Boolean);
  json(res, 200, { ok: true, threads, unread: unreadQ.get(builder.id).n });
}
function thread(res, builder, otherId) {
  const other = byId.get(otherId);
  if (!other) return json(res, 404, { error: "This member is no longer in the directory." });
  if (markRead.run(Date.now(), builder.id, otherId).changes) scheduleBackup();
  json(res, 200, { ok: true, with: publicView(other), messages: threadQ.all({ a: builder.id, b: otherId }).reverse().map(m => msgView(m, builder.id)),
    blocked: !!blockedQ.get(builder.id, otherId), unread: unreadQ.get(builder.id).n });
}
async function sendMessage(req, res, builder, otherId) {
  if (limited("dm:" + builder.id, 20)) return json(res, 429, { error: "You're sending messages too fast, please wait a minute." });
  let b;
  try { b = await readBody(req, 8192); } catch { return json(res, 400, { error: "Invalid request." }); }
  const body = typeof b.body === "string" ? b.body.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, 1000) : "";
  if (!body) return json(res, 400, { error: "Write a message first." });
  const other = otherId !== builder.id && byId.get(otherId);
  if (!other) return json(res, 404, { error: "This member is no longer in the directory." });
  if (blockedQ.get(other.id, builder.id)) return json(res, 403, { error: "This member isn't accepting your messages." });
  const now = Date.now(), fresh = !pairExists.get({ a: builder.id, b: other.id });
  if (fresh && newThreadsToday.get({ me: builder.id, since: now - DAY }).n >= MAX_NEW_THREADS_PER_DAY)
    return json(res, 429, { error: "You've started 20 new conversations today. Try again tomorrow." });
  dropBlock.run(builder.id, other.id); // escribirle a alguien lo desbloquea
  const firstUnread = unreadQ.get(other.id).n === 0;
  persistWithEmail(() => {
    insertMessage.run(randomUUID(), builder.id, other.id, body, now);
    // un solo aviso por correo hasta que lea, y nunca si ese correo ya recibió algo hoy (no gastar su cupo de enlaces de acceso)
    if (firstUnread && loginLoad(other.email) === 0) EMAIL.enqueue("dm", { id: randomUUID(), email: other.email });
  });
  scheduleBackup();
  thread(res, builder, other.id);
}
function setBlock(res, builder, otherId, on) {
  if (!byId.get(otherId) || otherId === builder.id) return json(res, 404, { error: "not found" });
  on ? addBlock.run(builder.id, otherId, Date.now()) : dropBlock.run(builder.id, otherId);
  scheduleBackup();
  json(res, 200, { ok: true, blocked: on });
}

const deleteBuilder = db.prepare("DELETE FROM builders WHERE id = ?");
const deleteJobsOf = db.prepare("DELETE FROM jobs WHERE builder_id = ?");
const deleteTokensOf = db.prepare("DELETE FROM member_tokens WHERE builder_id = ?");
function removeProfile(res, builder) {
  if (openEscrowOf.get(builder.id))
    return json(res, 409, { error: "You have bounty money in escrow. Pick a winner or close the bounty and wait for the refund before removing your profile." });
  persistWithEmail(() => { deleteMessagesOf.run(builder.id, builder.id); deleteBlocksOf.run(builder.id, builder.id); deleteJobsOf.run(builder.id); deleteBountiesOf.run(builder.id); deleteTokensOf.run(builder.id); deleteBuilder.run(builder.id); });
  if (builder.avatar) STORAGE?.remove(builder.avatar).catch(() => {});
  if (builder.brochure) STORAGE?.remove(builder.brochure).catch(() => {});
  scheduleBackup();
  broadcast({ type: "remove", id: builder.id, total: totalQ.get().n });
  json(res, 200, { ok: true });
}

// ---------- bounties ----------
const BOUNTY_CATEGORIES = ["intro", "product", "content", "other"];
const deleteBountiesOf = db.prepare("DELETE FROM bounties WHERE builder_id = ?");
const insertBounty = db.prepare(`INSERT INTO bounties (id,builder_id,title,category,reward,reward_usd,description,submit,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
const closeBounty = db.prepare("UPDATE bounties SET closed_at = ? WHERE id = ? AND builder_id = ? AND closed_at IS NULL");
const openBountiesCount = db.prepare("SELECT COUNT(*) n FROM bounties WHERE builder_id = ? AND closed_at IS NULL AND expires_at > ?");
const ESCROW = `(SELECT COUNT(*) FROM bounty_funds f WHERE f.bounty_id = x.id AND f.status = 'paid') AS escrow`;
const bountiesQ = db.prepare(`SELECT x.*, ${ESCROW}, b.name AS poster, b.kind AS poster_kind, b.avatar AS poster_avatar FROM bounties x JOIN builders b ON b.id = x.builder_id
  WHERE x.closed_at IS NULL AND x.expires_at > :now AND (:category = '' OR x.category = :category)
    AND (:q = '' OR x.title LIKE :like OR x.description LIKE :like OR x.reward LIKE :like OR b.name LIKE :like)
  ORDER BY x.expires_at ASC LIMIT 60 OFFSET :offset`);
const openBountiesTotal = db.prepare("SELECT COUNT(*) n FROM bounties WHERE closed_at IS NULL AND expires_at > ?");
function bountyView(x, poster = { name: x.poster, kind: x.poster_kind, avatar: x.poster_avatar }) {
  return { id: x.id, title: x.title, category: x.category, reward: x.reward, rewardUsd: x.reward_usd || null, funded: x.escrow > 0,
    description: x.description || "", submit: x.submit,
    poster: { id: x.builder_id, name: poster.name, kind: poster.kind || "person", avatar: poster.avatar ? `/media/${poster.avatar}` : "" },
    ts: x.created_at, deadline: x.expires_at };
}
// enlace o correo para entregar; misma regla que "How to apply" de empleos
function contactLink(value) {
  let v = clean(value, 200);
  if (EMAIL_RE.test(v) && !/^https?:/i.test(v)) return "mailto:" + v.replace(/^mailto:/i, "");
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  try { const u = new URL(v); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null; return u.href; } catch { return null; }
}
function parseBounty(b, now) {
  const title = clean(b.title, 90);
  if (title.length < 3) return { error: "Add a title for the bounty." };
  const category = BOUNTY_CATEGORIES.includes(b.category) ? b.category : null;
  if (!category) return { error: "Pick a category." };
  // reward_usd (opcional): monto en USD enteros que se puede depositar en escrow con MoonPay
  const rewardUsd = parseRewardUsd(b.reward_usd);
  if (rewardUsd !== null && !(rewardUsd >= MIN_REWARD_USD && rewardUsd <= MAX_REWARD_USD))
    return { error: `Escrow rewards are whole USD between ${MIN_REWARD_USD} and ${MAX_REWARD_USD.toLocaleString("en-US")}.` };
  const reward = clean(b.reward, 60) || (rewardUsd ? `USD ${rewardUsd.toLocaleString("en-US")}` : "");
  if (reward.length < 2) return { error: "Add the reward, for example USD 500 or 10% of the first deal." };
  const submit = contactLink(b.submit);
  if (!submit) return { error: "Add a link or an email where people submit." };
  // fecha límite YYYY-MM-DD (fin del día en Bogotá), entre mañana y 180 días; por defecto 30 días
  let expires = now + 30 * DAY;
  if (b.deadline) {
    const t = Date.parse(String(b.deadline).slice(0, 10) + "T23:59:59-05:00");
    if (!Number.isFinite(t) || t < now + HOUR || t > now + 180 * DAY) return { error: "Pick a deadline within the next 6 months." };
    expires = t;
  }
  return { title, category, reward, rewardUsd, submit, expires, description: clean(String(b.description || "").replace(/\r?\n/g, " "), 800) };
}
async function postBounty(req, res, builder) {
  if (limited("bounty:" + builder.id, 10, HOUR)) return json(res, 429, { error: "Too many bounties, please wait a while." });
  let b;
  try { b = await readBody(req); } catch { return json(res, 400, { error: "Invalid request." }); }
  const now = Date.now(), x = parseBounty(b, now);
  if (x.error) return json(res, 400, { error: x.error });
  if (openBountiesCount.get(builder.id, now).n >= 10) return json(res, 400, { error: "You can have up to 10 open bounties. Close one first." });
  insertBounty.run(randomUUID(), builder.id, x.title, x.category, x.reward, x.rewardUsd, x.description, x.submit, now, x.expires);
  scheduleBackup();
  const row = byId.get(builder.id);
  broadcast({ type: "bounties" });
  json(res, 201, { ok: true, me: me(row) });
}
function endBounty(res, builder, id) {
  // cerrar un bounty con depósito sin ganador pide el reembolso (lo paga LATAMACC; ver scripts/bounty-payouts.mjs)
  const closed = persistWithEmail(() => {
    if (!closeBounty.run(Date.now(), id, builder.id).changes) return false;
    requestRefund.run(id);
    return true;
  });
  if (!closed) return json(res, 404, { error: "Bounty not found." });
  scheduleBackup();
  broadcast({ type: "bounties" });
  json(res, 200, { ok: true, me: me(byId.get(builder.id)) });
}

// ---------- escrow de bounties (payment rails) ----------
const insertFund = db.prepare(`INSERT INTO bounty_funds (id,bounty_id,builder_id,title,reward_usd,fee_usd,total_usd,payment_amount,payment_currency,status,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,'awaiting_payment',?)`);
const attachFund = db.prepare("UPDATE bounty_funds SET charge_token = ?, charge_id = ?, checkout_url = ?, expires_at = ? WHERE id = ?");
const fundStatus = db.prepare("UPDATE bounty_funds SET status = ? WHERE id = ? AND status IN ('awaiting_payment','expired','payment_failed')");
const confirmFund = db.prepare(`UPDATE bounty_funds SET status = 'paid', payment_tx_id = ?, payment_signature = ?, paid_at = ?
  WHERE id = ? AND status IN ('awaiting_payment','expired','payment_failed')`);
const awardFund = db.prepare("UPDATE bounty_funds SET status = 'awarded', winner_name = ?, winner_wallet = ?, awarded_at = ? WHERE id = ? AND status = 'paid'");
const requestRefund = db.prepare("UPDATE bounty_funds SET status = 'refund_requested' WHERE bounty_id = ? AND status = 'paid'");
const fundById = db.prepare("SELECT * FROM bounty_funds WHERE id = ?");
const fundByCharge = db.prepare("SELECT * FROM bounty_funds WHERE charge_token = ?");
const fundByTransaction = db.prepare("SELECT id FROM bounty_funds WHERE payment_tx_id = ?");
const latestFund = db.prepare("SELECT * FROM bounty_funds WHERE bounty_id = ? ORDER BY (status = 'paid') DESC, created_at DESC LIMIT 1");
const paidFund = db.prepare("SELECT * FROM bounty_funds WHERE bounty_id = ? AND status = 'paid' ORDER BY paid_at LIMIT 1");
const myFundsQ = db.prepare(`SELECT * FROM bounty_funds WHERE builder_id = ? AND status IN ('awarded','refund_requested','paid_out','refunded')
  ORDER BY created_at DESC LIMIT 10`);
const openEscrowOf = db.prepare("SELECT 1 FROM bounty_funds WHERE builder_id = ? AND status IN ('paid','awarded','refund_requested') LIMIT 1");
const myUnclosedBounty = db.prepare("SELECT 1 FROM bounties WHERE id = ? AND builder_id = ? AND closed_at IS NULL");
const myOpenBounty = db.prepare("SELECT * FROM bounties WHERE id = ? AND builder_id = ? AND closed_at IS NULL AND expires_at > ?");
function fundingView(f) {
  if (!f) return null;
  return { id: f.id, title: f.title, status: f.status, reward: f.reward_usd, fee: f.fee_usd, total: f.total_usd,
    checkoutUrl: f.status === "awaiting_payment" ? f.checkout_url : null, expiresAt: f.expires_at,
    winner: f.winner_name || null, wallet: f.winner_wallet || null, signature: f.settle_signature || null };
}
// El escrow custodia dinero de terceros: se enciende explícitamente con BOUNTY_ESCROW=1 en el servicio.
const ESCROW_ON = process.env.BOUNTY_ESCROW === "1";
const bountyPayments = () => ({ enabled: ESCROW_ON && !!MOONPAY, feeBps: FEE_BPS, minFee: MIN_FEE_USD, minReward: MIN_REWARD_USD, maxReward: MAX_REWARD_USD });

// Mismo criterio que la tienda: solo la consulta a MoonPay (nunca el webhook ni el navegador) confirma un depósito.
async function reconcileFunding(f) {
  if (!["awaiting_payment", "expired", "payment_failed"].includes(f.status) || !f.charge_token) return f;
  if (!MOONPAY) throw new Error("Payment verification is unavailable.");
  const result = validateCharge(await MOONPAY.getCharge(f.charge_token), f, MOONPAY_CONFIG);
  if (result.status === "paid") {
    persistWithEmail(() => {
      const used = fundByTransaction.get(result.transactionId);
      if ((used && used.id !== f.id) || orderByTransaction.get(result.transactionId))
        throw new Error("Payment transaction is already attached to another order.");
      confirmFund.run(result.transactionId, result.signature, Date.now(), f.id);
    });
    broadcast({ type: "bounties" });
  } else if (result.status !== f.status) fundStatus.run(result.status, f.id);
  if (result.status !== f.status) scheduleBackup();
  return fundById.get(f.id);
}

async function fundBounty(res, builder, id) {
  if (!ESCROW_ON || !MOONPAY) return json(res, 503, { error: "Escrow payments are not available right now." });
  if (limited("fund:" + builder.id, 10, HOUR)) return json(res, 429, { error: "Too many attempts, please wait a while." });
  const x = myOpenBounty.get(id, builder.id, Date.now());
  if (!x) return json(res, 404, { error: "Bounty not found." });
  if (!x.reward_usd) return json(res, 400, { error: "This bounty has no USD reward to deposit." });
  let f = latestFund.get(id);
  // un cobro que nunca recibió checkout (caída a mitad de la creación) no bloquea el bounty para siempre
  if (f?.status === "awaiting_payment" && !f.charge_token && f.created_at < Date.now() - 2 * 60_000) {
    fundStatus.run("payment_failed", f.id); f = fundById.get(f.id);
  }
  if (f) {
    try { f = await reconcileFunding(f); } catch { return json(res, 502, { error: "Payment status is temporarily unavailable. Please try again." }); }
    if (f.status === "awaiting_payment" && f.checkout_url) return json(res, 200, { ok: true, funding: fundingView(f) });
    if (!["expired", "payment_failed"].includes(f.status)) return json(res, 409, { error: "This bounty is already funded." });
  }
  const q = bountyQuote(x.reward_usd);
  const row = { id: randomUUID(), payment_amount: usdToMinor(q.total), payment_currency: USD_ID };
  try { insertFund.run(row.id, x.id, builder.id, x.title, q.reward, q.fee, q.total, row.payment_amount, row.payment_currency, Date.now()); }
  catch { return json(res, 409, { error: "A checkout for this bounty is already open." }); }
  scheduleBackup();
  try {
    const charge = await MOONPAY.createCharge(row, { returnUrl: `https://latamacc.si/?bounty=${x.id}#bounties`, customerDetails: {
      email: builder.email, fullName: builder.name, country: builder.country,
      additionalJSON: JSON.stringify({ bountyId: x.id, fundingId: row.id, reward: q.reward, fee: q.fee }) } });
    attachFund.run(charge.token, charge.id, charge.checkoutUrl, charge.expiresAt, row.id);
  } catch {
    fundStatus.run("payment_failed", row.id);
    return json(res, 502, { error: "Checkout is temporarily unavailable. Please try again." });
  }
  json(res, 201, { ok: true, funding: fundingView(fundById.get(row.id)) });
}

async function fundingStatus(req, res, builder, id) {
  if (limited("fundstatus:" + builder.id, 60)) return json(res, 429, { error: "Please wait before checking again." });
  let f = latestFund.get(id);
  if (!f || f.builder_id !== builder.id) return json(res, 404, { error: "No deposit for this bounty." });
  try { f = await reconcileFunding(f); } catch { return json(res, 502, { error: "Payment status is temporarily unavailable. Please try again." }); }
  json(res, 200, { ok: true, funding: fundingView(f), me: me(byId.get(builder.id)) });
}

// El autor elige ganador: el bounty se cierra y el pago queda en la cola de LATAMACC.
async function awardBounty(req, res, builder, id) {
  let b;
  try { b = await readBody(req); } catch { return json(res, 400, { error: "Invalid request." }); }
  const winner = clean(b.winner, 80), wallet = clean(b.wallet, 64);
  if (winner.length < 2) return json(res, 400, { error: "Add the winner's name." });
  if (!solanaAddressOk(wallet)) return json(res, 400, { error: "Add the winner's Solana wallet address (USDC is paid on Solana)." });
  const awarded = persistWithEmail(() => {
    const f = paidFund.get(id);
    if (!f || f.builder_id !== builder.id || !myUnclosedBounty.get(id, builder.id)) return false;
    awardFund.run(winner, wallet, Date.now(), f.id);
    closeBounty.run(Date.now(), id, builder.id);
    return true;
  });
  if (!awarded) return json(res, 409, { error: "Only open bounties with money in escrow can be awarded." });
  scheduleBackup();
  broadcast({ type: "bounties" });
  json(res, 200, { ok: true, me: me(byId.get(builder.id)) });
}

// ---------- empleos ----------
const WORKPLACES = ["remote", "hybrid", "onsite"], JOB_TYPES = ["full-time", "part-time", "contract", "internship"];
const insertJob = db.prepare(`INSERT INTO jobs (id,builder_id,title,company,country,city,workplace,type,salary,description,apply,created_at,expires_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const closeJob = db.prepare("UPDATE jobs SET closed_at = ? WHERE id = ? AND builder_id = ? AND closed_at IS NULL");
const openJobsCount = db.prepare("SELECT COUNT(*) n FROM jobs WHERE builder_id = ? AND closed_at IS NULL AND expires_at > ?");
const jobsQ = db.prepare(`SELECT j.*, b.name AS poster, b.kind AS poster_kind, b.avatar AS poster_avatar, b.company AS poster_company FROM jobs j JOIN builders b ON b.id = j.builder_id
  WHERE j.closed_at IS NULL AND j.expires_at > :now
    AND (:country = '' OR j.country = :country) AND (:workplace = '' OR j.workplace = :workplace) AND (:type = '' OR j.type = :type)
    AND (:q = '' OR j.title LIKE :like OR j.company LIKE :like OR b.name LIKE :like OR j.description LIKE :like OR j.city LIKE :like)
  ORDER BY j.created_at DESC LIMIT 60 OFFSET :offset`);
const openJobsTotal = db.prepare("SELECT COUNT(*) n FROM jobs WHERE closed_at IS NULL AND expires_at > ?");
function jobView(j, poster = { name: j.poster, kind: j.poster_kind, avatar: j.poster_avatar, company: j.poster_company }) {
  return { id: j.id, title: j.title, company: j.company || (poster.kind === "company" ? poster.name : poster.company) || "", country: j.country || "", city: j.city || "",
    workplace: j.workplace, type: j.type, salary: j.salary || "", description: j.description || "", apply: j.apply,
    poster: { id: j.builder_id, name: poster.name, kind: poster.kind || "person", avatar: poster.avatar ? `/media/${poster.avatar}` : "" },
    ts: j.created_at, expires: j.expires_at };
}
function parseJob(b) {
  const title = clean(b.title, 80);
  if (title.length < 3) return { error: "Add a job title." };
  const workplace = WORKPLACES.includes(b.workplace) ? b.workplace : null;
  if (!workplace) return { error: "Pick remote, hybrid or on-site." };
  const type = JOB_TYPES.includes(b.type) ? b.type : null;
  if (!type) return { error: "Pick the type of job." };
  const country = clean(b.country, 2).toUpperCase();
  if (country && !COUNTRIES.has(country)) return { error: "Pick a Latam country." };
  if (!country && workplace !== "remote") return { error: "Pick the country for this job." };
  let apply = clean(b.apply, 200);
  if (EMAIL_RE.test(apply) && !/^https?:/i.test(apply)) apply = "mailto:" + apply.replace(/^mailto:/i, "");
  else {
    if (!/^https?:\/\//i.test(apply)) apply = "https://" + apply;
    try { const u = new URL(apply); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw 0; apply = u.href; }
    catch { return { error: "Add a link or an email to apply." }; }
  }
  return { title, workplace, type, country, apply, company: clean(b.company, 80), city: clean(b.city, 60),
    salary: clean(b.salary, 60), description: clean(String(b.description || "").replace(/\r?\n/g, " "), 600) };
}
async function postJob(req, res, builder) {
  if (limited("job:" + builder.id, 10, HOUR)) return json(res, 429, { error: "Too many job posts, please wait a while." });
  let b;
  try { b = await readBody(req); } catch { return json(res, 400, { error: "Invalid request." }); }
  const j = parseJob(b);
  if (j.error) return json(res, 400, { error: j.error });
  const now = Date.now();
  if (openJobsCount.get(builder.id, now).n >= 10) return json(res, 400, { error: "You can have up to 10 open jobs. Close one first." });
  const id = randomUUID();
  insertJob.run(id, builder.id, j.title, j.company, j.country, j.city, j.workplace, j.type, j.salary, j.description, j.apply, now, now + 60 * DAY);
  scheduleBackup();
  const row = byId.get(builder.id);
  broadcast({ type: "jobs", builder: publicView(row) });
  json(res, 201, { ok: true, me: me(row) });
}
function endJob(res, builder, id) {
  if (!closeJob.run(Date.now(), id, builder.id).changes) return json(res, 404, { error: "Job not found." });
  scheduleBackup();
  const row = byId.get(builder.id);
  broadcast({ type: "jobs", builder: publicView(row) });
  json(res, 200, { ok: true, me: me(row) });
}

async function merchPreorder(req, res) {
  const ip = clientIp(req);
  if (limited(ip)) return json(res, 429, { error: "Too many attempts, please wait a minute." });
  let b;
  try { b = await readBody(req); } catch { return json(res, 400, { error: "Invalid request." }); }
  const human = await humanCheck(b, ip);
  if (human === "bot") return json(res, 200, { ok: true });
  if (human) return json(res, 400, { error: human });
  const item = Object.hasOwn(MERCH, b.item) ? b.item : null;
  const email = clean(b.email, 120).toLowerCase();
  const size = clean(b.size, 4).toUpperCase();
  const qty = Number(b.qty);
  const country = clean(b.country, 2).toUpperCase();
  if (!item) return json(res, 400, { error: "Pick a tee or a cap." });
  if (!MERCH[item].sizes.includes(size)) return json(res, 400, { error: "Pick a size." });
  if (!Number.isInteger(qty) || !(qty >= 1 && qty <= 10)) return json(res, 400, { error: "Quantity must be 1 to 10." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "Invalid email." });
  if (!COUNTRIES.has(country)) return json(res, 400, { error: "Pick a Latam country for shipping." });
  const order = { id: randomUUID(), item, size, qty, name: clean(b.name, 60), email, country, created_at: Date.now() };
  persistWithEmail(() => {
    insertOrder.run(order.id, item, size, qty, order.name, email, country, ip, order.created_at);
    if (!(MERCH[item].pay && MOONPAY)) EMAIL.enqueue("reserved", order);
  });
  scheduleBackup();
  const total = MERCH[item].price && MERCH[item].price * qty;
  if (MERCH[item].pay && MOONPAY) {
    const statusToken = randomBytes(32).toString("base64url");
    order.payment_amount = String(BigInt(total * 100) * 10_000n);
    startPayment.run(total * 100, order.payment_amount, USD_ID, statusToken, order.id);
    try {
      const charge = await MOONPAY.createCharge(order);
      attachCharge.run(charge.token, charge.id, charge.checkoutUrl, charge.expiresAt, order.id);
      scheduleBackup();
      return json(res, 201, { ok: true, id: order.id, item, size, qty, total,
        payment: { checkoutUrl: charge.checkoutUrl, statusToken, status: "awaiting_payment" } });
    } catch {
      paymentStatus.run("payment_failed", order.id);
      scheduleBackup();
      return json(res, 502, { error: "Checkout is temporarily unavailable. Please try again." });
    }
  }
  json(res, 201, { ok: true, id: order.id, item, size, qty, total });
}

async function reconcilePayment(order) {
  if (order.status === "paid") return order;
  if (!MOONPAY || !order.charge_token) throw new Error("Payment verification is unavailable.");
  const charge = await MOONPAY.getCharge(order.charge_token);
  const result = validateCharge(charge, order, MOONPAY_CONFIG);
  if (result.status === "paid") {
    persistWithEmail(() => {
      const used = orderByTransaction.get(result.transactionId);
      if ((used && used.id !== order.id) || fundByTransaction.get(result.transactionId))
        throw new Error("Payment transaction is already attached to another order.");
      if (confirmPayment.run(result.transactionId, result.signature, Date.now(), order.id).changes)
        EMAIL.enqueue("paid", order);
    });
  } else paymentStatus.run(result.status, order.id);
  if (result.status !== order.status) scheduleBackup();
  return orderByStatus.get(order.status_token);
}

async function merchStatus(req, res) {
  if (limited(clientIp(req), 90)) return json(res, 429, { error: "Please wait before checking again." });
  const token = new URL(req.url, "http://x").searchParams.get("token") || "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return json(res, 404, { error: "Order not found." });
  let order = orderByStatus.get(token);
  if (!order) return json(res, 404, { error: "Order not found." });
  if (order.status !== "paid" && !MOONPAY) return json(res, 503, { error: "Payment verification is temporarily unavailable." });
  try { order = await reconcilePayment(order); }
  catch { return json(res, 502, { error: "Payment status is temporarily unavailable. Please try again." }); }
  return json(res, 200, { ok: true, status: order.status, item: order.item, size: order.size, qty: order.qty, total: order.total_cents / 100 });
}

async function moonpayWebhook(req, res) {
  if (!MOONPAY_CONFIG?.webhookToken) return json(res, 503, { error: "Webhook is not configured." });
  let raw;
  try { raw = await readRawBody(req, 128 * 1024); }
  catch { return json(res, 400, { error: "Invalid request." }); }
  if (!verifyWebhook(raw, req.headers, MOONPAY_CONFIG.webhookToken)) return json(res, 401, { error: "Invalid signature." });
  let payload;
  try { payload = JSON.parse(raw.toString("utf8")); }
  catch { return json(res, 400, { error: "Invalid request." }); }
  if (payload.event !== "CREATED" || typeof payload.chargeToken !== "string") return json(res, 200, { ok: true });
  const order = orderByCharge.get(payload.chargeToken), fund = order ? null : fundByCharge.get(payload.chargeToken);
  if (!order && !fund) return json(res, 200, { ok: true });
  // Signed notifications trigger a separate provider lookup; the payload itself never authorizes fulfilment.
  try { if (order) await reconcilePayment(order); else await reconcileFunding(fund); }
  catch { return json(res, 503, { error: "Payment verification unavailable." }); }
  return json(res, 200, { ok: true });
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

async function serveStatic(req, res) {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC)) return json(res, 400, { error: "bad path" });
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error();
    const ext = extname(file);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": [".html", ".js", ".css", ".json"].includes(ext) ? "no-cache" : "public, max-age=3600",
    });
    let body = await readFile(file);
    if (ext === ".html") {
      // versiona app.js y styles.css por fecha de modificación para saltar la caché de Cloudflare
      let html = body.toString("utf8");
      for (const asset of ["app.js", "styles.css"]) {
        const v = Math.floor((await stat(join(PUBLIC, asset))).mtimeMs);
        html = html.replace(new RegExp(`/${asset.replace(".", "\\.")}(\\?v=\\d+)?"`), `/${asset}?v=${v}"`);
      }
      body = html;
    }
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": MIME[".html"] });
    res.end(await readFile(join(PUBLIC, "404.html")));
  }
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://x");
    if (pathname === "/api/state" && req.method === "GET") {
      const you = String(req.headers["cf-ipcountry"] || "").toUpperCase();
      return json(res, 200, { ...state(), you: COUNTRIES.has(you) ? you : "", ft: formToken(), turnstile: TURNSTILE?.sitekey || null });
    }
    if (pathname === "/api/health" && req.method === "GET") return json(res, 200, health());
    if (pathname === "/api/directory" && req.method === "GET") {
      const u = new URL(req.url, "http://x").searchParams;
      const q = clean(u.get("q") || "", 60), country = clean(u.get("country") || "", 2).toUpperCase(), kind = clean(u.get("kind") || "", 10);
      const f = { q, like: `%${q}%`, country, kind: ["person", "company"].includes(kind) ? kind : "", calls: u.get("calls") === "1" ? 1 : 0 };
      const rows = directoryQ.all({ ...f, offset: Math.max(0, Number(u.get("offset")) || 0) });
      return json(res, 200, { entries: rows.map(publicView), count: directoryCountQ.get(f).n });
    }
    if (pathname === "/api/register" && req.method === "POST") return await register(req, res);
    if (pathname === "/api/search" && req.method === "GET") {
      if (limited("search:" + clientIp(req), 60)) return json(res, 429, { error: "Too many searches, please wait a minute." });
      return search(res, new URL(req.url, "http://x").searchParams.get("q") || "");
    }
    if (pathname === "/api/jobs" && req.method === "GET") {
      const u = new URL(req.url, "http://x").searchParams;
      const q = clean(u.get("q") || "", 60), country = clean(u.get("country") || "", 2).toUpperCase();
      const workplace = WORKPLACES.includes(u.get("workplace")) ? u.get("workplace") : "", type = JOB_TYPES.includes(u.get("type")) ? u.get("type") : "";
      const rows = jobsQ.all({ q, like: `%${q}%`, country, workplace, type, now: Date.now(), offset: Math.max(0, Number(u.get("offset")) || 0) });
      return json(res, 200, { jobs: rows.map(j => jobView(j)) });
    }
    if (pathname === "/api/invite" && req.method === "GET") {
      const inviter = inviterOf(new URL(req.url, "http://x").searchParams.get("ref"));
      if (!inviter) return json(res, 404, { error: "Invite not found." });
      return json(res, 200, { ref: refOf(inviter.id), name: inviter.name, n: inviter.n, kind: inviter.kind, country: inviter.country });
    }
    if (pathname === "/api/bounties" && req.method === "GET") {
      const u = new URL(req.url, "http://x").searchParams;
      const q = clean(u.get("q") || "", 60), category = BOUNTY_CATEGORIES.includes(u.get("category")) ? u.get("category") : "";
      const rows = bountiesQ.all({ q, like: `%${q}%`, category, now: Date.now(), offset: Math.max(0, Number(u.get("offset")) || 0) });
      return json(res, 200, { bounties: rows.map(x => bountyView(x)) });
    }
    if (pathname === "/api/signin/link" && req.method === "POST") return await requestLink(req, res);
    if (pathname === "/api/signin" && req.method === "POST") return await startSession(req, res);
    if (pathname === "/api/me" || pathname.startsWith("/api/me/")) {
      const builder = sessionOf(req);
      if (!builder) return json(res, 401, { error: "Please sign in again." });
      if (pathname === "/api/me" && req.method === "GET") return json(res, 200, { ok: true, me: me(builder) });
      if (pathname === "/api/me" && req.method === "POST") return await saveProfile(req, res, builder);
      if (pathname === "/api/me" && req.method === "DELETE") return removeProfile(res, builder);
      if (pathname === "/api/me/avatar" && req.method === "POST") return await uploadAvatar(req, res, builder);
      if (pathname === "/api/me/avatar" && req.method === "DELETE") return removeAvatar(res, builder);
      if (pathname === "/api/me/unread" && req.method === "GET") return json(res, 200, { ok: true, unread: unreadQ.get(builder.id).n });
      if (pathname === "/api/me/inbox" && req.method === "GET") return inbox(res, builder);
      const dm = /^\/api\/me\/messages\/([0-9a-f-]{36})(\/block|\/unblock)?$/.exec(pathname);
      if (dm && !dm[2] && req.method === "GET") return thread(res, builder, dm[1]);
      if (dm && !dm[2] && req.method === "POST") return await sendMessage(req, res, builder, dm[1]);
      if (dm && dm[2] && req.method === "POST") return setBlock(res, builder, dm[1], dm[2] === "/block");
      if (pathname === "/api/me/network" && req.method === "POST") return await saveNetwork(req, res, builder);
      if (pathname === "/api/me/matches" && req.method === "GET") return networkMatches(res, builder);
      if (pathname === "/api/me/brochure" && req.method === "POST") return await uploadBrochure(req, res, builder);
      if (pathname === "/api/me/brochure" && req.method === "DELETE") return removeBrochure(res, builder);
      if (pathname === "/api/me/signout" && req.method === "POST") {
        dropToken.run(tokenHash(String(req.headers.authorization).slice(7)));
        return json(res, 200, { ok: true });
      }
      if (pathname === "/api/me/jobs" && req.method === "POST") return await postJob(req, res, builder);
      if (pathname === "/api/me/bounties" && req.method === "POST") return await postBounty(req, res, builder);
      const closeB = /^\/api\/me\/bounties\/([0-9a-f-]{36})\/close$/.exec(pathname);
      if (closeB && req.method === "POST") return endBounty(res, builder, closeB[1]);
      const fundB = /^\/api\/me\/bounties\/([0-9a-f-]{36})\/(fund|award)$/.exec(pathname);
      if (fundB && fundB[2] === "fund" && req.method === "POST") return await fundBounty(res, builder, fundB[1]);
      if (fundB && fundB[2] === "fund" && req.method === "GET") return await fundingStatus(req, res, builder, fundB[1]);
      if (fundB && fundB[2] === "award" && req.method === "POST") return await awardBounty(req, res, builder, fundB[1]);
      const close = /^\/api\/me\/jobs\/([0-9a-f-]{36})\/close$/.exec(pathname);
      if (close && req.method === "POST") return endJob(res, builder, close[1]);
      return json(res, 404, { error: "not found" });
    }
    if (pathname === "/api/merch/preorder" && req.method === "POST") return await merchPreorder(req, res);
    if (pathname === "/api/merch/status" && req.method === "GET") return await merchStatus(req, res);
    if (pathname === "/api/moonpay/webhook" && req.method === "POST") return await moonpayWebhook(req, res);
    if (pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
    const media = MEDIA_RE.exec(pathname);
    if (media && (req.method === "GET" || req.method === "HEAD")) return await serveMedia(req, res, media[1], media[2] || media[3]);
    return await serveStatic(req, res);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: "Something went wrong." });
  }
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 1024 });

function broadcast(msg, except) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c !== except && c.readyState === 1) c.send(data);
}

wss.on("connection", (ws, req) => {
  ws.sparks = [];
  const cc = String(req.headers["cf-ipcountry"] || "").toUpperCase();
  ws.cc = COUNTRIES.has(cc) ? cc : "";
  ws.send(JSON.stringify({ type: "hello", ...presence() }));
  broadcast({ type: "presence", ...presence() }, ws);
  ws.on("message", raw => {
    // Chispas: cuando alguien hace clic en el mapa, todos lo ven.
    const now = Date.now();
    ws.sparks = ws.sparks.filter(t => now - t < 1000);
    if (ws.sparks.length >= 8) return;
    ws.sparks.push(now);
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type !== "spark") return;
    const x = Number(m.x), y = Number(m.y);
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return;
    broadcast({ type: "spark", x, y }, ws);
  });
  ws.on("close", () => broadcast({ type: "presence", ...presence() }));
});

// Mantiene vivas las conexiones a través del túnel.
setInterval(() => { for (const c of wss.clients) if (c.readyState === 1) c.ping(); }, 25_000);

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { EMAIL.stop(); backup(); db.close(); STORAGE?.close(); process.exit(0); });

server.listen(PORT, HOST, () => console.log(`latamacc en http://${HOST}:${server.address().port}`));
