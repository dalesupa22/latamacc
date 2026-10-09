// Servidor de latamacc.si: estáticos, directorio de builders/empresas de IA y WebSocket en vivo.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { mkdirSync, readFileSync, readdirSync, rmSync, chmodSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";
import { loadMoonpayConfig, MoonpayCommerce, USD_ID, validateCharge, verifyWebhook } from "./lib/moonpay.mjs";

const ROOT = new URL(".", import.meta.url).pathname;
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || "127.0.0.1";

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
for (const [col, def] of [["kind", "TEXT NOT NULL DEFAULT 'person'"], ["company", "TEXT"], ["website", "TEXT"]])
  if (!cols.has(col)) db.exec(`ALTER TABLE builders ADD COLUMN ${col} ${def}`);
const insert = db.prepare(`INSERT INTO builders (id,kind,name,company,email,country,city,building,website,handle,ip,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
const directoryQ = db.prepare(`SELECT rowid AS n, * FROM builders
  WHERE (:country = '' OR country = :country) AND (:kind = '' OR kind = :kind)
    AND (:q = '' OR name LIKE :like OR company LIKE :like OR building LIKE :like OR city LIKE :like)
  ORDER BY created_at DESC LIMIT 60 OFFSET :offset`);
const byEmail = db.prepare(`SELECT rowid AS n, * FROM builders WHERE email = ?`);
const recentQ = db.prepare(`SELECT rowid AS n, * FROM builders ORDER BY created_at DESC LIMIT 30`);
const numberQ = db.prepare(`SELECT rowid AS n FROM builders WHERE id = ?`);
const pointsQ = db.prepare(`SELECT id, country, created_at FROM builders ORDER BY created_at DESC LIMIT 5000`);
const countsQ = db.prepare(`SELECT country, COUNT(*) n FROM builders GROUP BY country`);
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
const confirmPayment = db.prepare(`UPDATE merch_orders SET status = 'paid', payment_tx_id = ?, payment_signature = ?, paid_at = ? WHERE id = ?`);
const ordersQ = db.prepare(`SELECT COUNT(*) n FROM merch_orders`);
const MERCH = {
  tee: { price: 49, sizes: ["S", "M", "L", "XL", "XXL"] },
  cap: { price: null, sizes: ["ONE"] }, // precio por confirmar
};
const MOONPAY_CONFIG = loadMoonpayConfig();
const MOONPAY = MOONPAY_CONFIG ? new MoonpayCommerce(MOONPAY_CONFIG) : null;
const merchPayments = () => ({ tee: !!MOONPAY, cap: false });

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

// Es un directorio público: el formulario avisa qué se publica. El correo nunca sale del servidor.
function publicView(r) {
  return { id: r.id, n: r.n, kind: r.kind || "person", name: r.name, company: r.company || "", country: r.country, city: r.city || "",
    building: r.building || "", website: r.website || "", handle: r.handle || "", ts: r.created_at };
}

function state() {
  return {
    total: totalQ.get().n,
    byCountry: Object.fromEntries(countsQ.all().map(r => [r.country, r.n])),
    recent: recentQ.all().map(publicView),
    points: pointsQ.all().map(r => ({ id: r.id, country: r.country, ts: r.created_at })),
    ...presence(),
    merchPayments: merchPayments(),
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
    turnstile: !!TURNSTILE, moonpay: !!MOONPAY, online: wss.clients.size };
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
  const name = clean(b.name, 60);
  const email = clean(b.email, 120).toLowerCase();
  const country = clean(b.country, 2).toUpperCase();
  const kind = b.kind === "company" ? "company" : "person";
  let website = clean(b.website, 120);
  if (website && !/^https?:\/\//i.test(website)) website = "https://" + website;
  try { if (website) { const u = new URL(website); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw 0; website = u.href; } }
  catch { return json(res, 400, { error: "That website doesn't look right." }); }
  if (name.length < 2) return json(res, 400, { error: kind === "company" ? "Add the company name." : "Add your name." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "Invalid email." });
  if (!COUNTRIES.has(country)) return json(res, 400, { error: "Pick a Latam country." });

  const existing = byEmail.get(email);
  if (existing) return json(res, 200, { ok: true, existing: true, builder: publicView(existing) });

  const row = {
    id: randomUUID(), kind, name, company: kind === "person" ? clean(b.company, 80) : "", email, country, website,
    city: clean(b.city, 60), building: clean(b.building, 140), handle: clean(b.handle, 30).replace(/^@/, ""),
    ip, created_at: Date.now(),
  };
  insert.run(row.id, row.kind, row.name, row.company, row.email, row.country, row.city, row.building, row.website, row.handle, row.ip, row.created_at);
  const pub = publicView({ ...row, n: numberQ.get(row.id).n });
  broadcast({ type: "join", builder: pub, total: totalQ.get().n });
  scheduleBackup();
  json(res, 201, { ok: true, builder: pub });
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
  if (!item) return json(res, 400, { error: "Pick the tee or the cap." });
  if (!MERCH[item].sizes.includes(size)) return json(res, 400, { error: "Pick a size." });
  if (!Number.isInteger(qty) || !(qty >= 1 && qty <= 10)) return json(res, 400, { error: "Quantity must be 1 to 10." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "Invalid email." });
  if (!COUNTRIES.has(country)) return json(res, 400, { error: "Pick a Latam country for shipping." });
  const order = { id: randomUUID(), item, size, qty, name: clean(b.name, 60), email, country, created_at: Date.now() };
  insertOrder.run(order.id, item, size, qty, order.name, email, country, ip, order.created_at);
  scheduleBackup();
  const total = MERCH[item].price && MERCH[item].price * qty;
  if (item === "tee" && MOONPAY) {
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
    const used = orderByTransaction.get(result.transactionId);
    if (used && used.id !== order.id) throw new Error("Payment transaction is already attached to another order.");
    confirmPayment.run(result.transactionId, result.signature, Date.now(), order.id);
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
  const order = orderByCharge.get(payload.chargeToken);
  if (!order) return json(res, 200, { ok: true });
  // Signed notifications trigger a separate provider lookup; the payload itself never authorizes fulfilment.
  try { await reconcilePayment(order); }
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
      const rows = directoryQ.all({ q, like: `%${q}%`, country, kind: ["person", "company"].includes(kind) ? kind : "", offset: Math.max(0, Number(u.get("offset")) || 0) });
      return json(res, 200, { entries: rows.map(publicView) });
    }
    if (pathname === "/api/register" && req.method === "POST") return await register(req, res);
    if (pathname === "/api/merch/preorder" && req.method === "POST") return await merchPreorder(req, res);
    if (pathname === "/api/merch/status" && req.method === "GET") return await merchStatus(req, res);
    if (pathname === "/api/moonpay/webhook" && req.method === "POST") return await moonpayWebhook(req, res);
    if (pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
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

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { backup(); db.close(); process.exit(0); });

server.listen(PORT, HOST, () => console.log(`latamacc en http://${HOST}:${server.address().port}`));
