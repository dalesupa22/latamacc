// Servidor de latamacc.si: estáticos, directorio de builders/empresas de IA y WebSocket en vivo.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { mkdirSync, readFileSync, readdirSync, rmSync, chmodSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";

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
// Pedidos de merch: lista de reservas, sin cobro (el pago se coordina por correo).
db.exec(`CREATE TABLE IF NOT EXISTS merch_orders (
  id TEXT PRIMARY KEY, item TEXT NOT NULL, size TEXT NOT NULL, qty INTEGER NOT NULL, name TEXT, email TEXT NOT NULL,
  country TEXT, ip TEXT, created_at INTEGER NOT NULL)`);
const insertOrder = db.prepare(`INSERT INTO merch_orders (id,item,size,qty,name,email,country,ip,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
const ordersQ = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(qty),0) units FROM merch_orders`);
const MERCH = { item: "latamacc-tee", price: 49, sizes: ["S", "M", "L", "XL", "XXL"] };
for (const f of [DB_FILE, DB_FILE + "-wal", DB_FILE + "-shm"]) { try { chmodSync(f, 0o600); } catch {} }

// Copias de seguridad: una al arrancar y cada hora si hubo registros nuevos; se guardan las últimas 72.
let lastBackup = null, lastBackupTotal = "";
function backup() {
  const total = `${totalQ.get().n}/${ordersQ.get().n}`;
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
const scheduleBackup = () => { clearTimeout(backupSoon); backupSoon = setTimeout(backup, 30_000); };

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
    lastBackup: lastBackup && { at: new Date(lastBackup.at).toISOString(), builders: lastBackup.builders, orders: lastBackup.orders }, orders: ordersQ.get().n, online: wss.clients.size };
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
  let size = 0, chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error("too large"); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function register(req, res) {
  const ip = clientIp(req);
  if (limited(ip)) return json(res, 429, { error: "Too many attempts, please wait a minute." });
  let b;
  try { b = await readBody(req); } catch { return json(res, 400, { error: "Invalid request." }); }
  if (b.hp_field) return json(res, 200, { ok: true }); // honeypot
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

async function merchOrder(req, res) {
  const ip = clientIp(req);
  if (limited(ip)) return json(res, 429, { error: "Too many attempts, please wait a minute." });
  let b;
  try { b = await readBody(req); } catch { return json(res, 400, { error: "Invalid request." }); }
  if (b.hp_field) return json(res, 200, { ok: true }); // honeypot
  const email = clean(b.email, 120).toLowerCase();
  const size = clean(b.size, 4).toUpperCase();
  const qty = Math.trunc(Number(b.qty));
  const country = clean(b.country, 2).toUpperCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "Invalid email." });
  if (!MERCH.sizes.includes(size)) return json(res, 400, { error: "Pick a size." });
  if (!(qty >= 1 && qty <= 10)) return json(res, 400, { error: "Quantity must be 1 to 10." });
  if (!COUNTRIES.has(country)) return json(res, 400, { error: "Pick a Latam country for shipping." });
  insertOrder.run(randomUUID(), MERCH.item, size, qty, clean(b.name, 60), email, country, ip, Date.now());
  scheduleBackup();
  json(res, 201, { ok: true, total: MERCH.price * qty });
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
      return json(res, 200, { ...state(), you: COUNTRIES.has(you) ? you : "" });
    }
    if (pathname === "/api/health" && req.method === "GET") return json(res, 200, health());
    if (pathname === "/api/directory" && req.method === "GET") {
      const u = new URL(req.url, "http://x").searchParams;
      const q = clean(u.get("q") || "", 60), country = clean(u.get("country") || "", 2).toUpperCase(), kind = clean(u.get("kind") || "", 10);
      const rows = directoryQ.all({ q, like: `%${q}%`, country, kind: ["person", "company"].includes(kind) ? kind : "", offset: Math.max(0, Number(u.get("offset")) || 0) });
      return json(res, 200, { entries: rows.map(publicView) });
    }
    if (pathname === "/api/register" && req.method === "POST") return await register(req, res);
    if (pathname === "/api/merch" && req.method === "POST") return await merchOrder(req, res);
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

server.listen(PORT, HOST, () => console.log(`latamacc en http://${HOST}:${PORT}`));
