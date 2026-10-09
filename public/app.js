// latamacc.si — mapa de Latam en oro (golden era) + directorio en vivo por WebSocket.

const $ = s => document.querySelector(s);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const mobile = matchMedia("(max-width: 900px)").matches;
const flag = cc => String.fromCodePoint(...[...cc].map(c => 0x1f1a5 + c.charCodeAt(0)));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- estado ----------
const S = {
  map: null, countries: [], byCode: {}, total: 0, byCountry: {}, online: 1,
  points: [], seen: new Set(), recent: [], watching: {},
};

// ---------- canvas ----------
const canvas = $("#map");
const ctx = canvas.getContext("2d");
let dpr = 1, cw = 0, ch = 0, scale = 1, ox = 0, oy = 0, px = 0, py = 0;
let mouse = { x: -1, y: -1, mx: -1, my: -1, inside: false, country: -1 };
let heroVisible = true;

function layout() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  cw = canvas.clientWidth; ch = canvas.clientHeight;
  canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
  if (!S.map) return;
  const { w, h } = S.map;
  let ax, ay, aw, ah;
  if (cw > 900) { ax = cw * 0.36; ay = 70; aw = cw * 0.62; ah = ch - 90; }
  else { ax = 10; ay = 64; aw = cw - 20; ah = ch * 0.56; }
  scale = Math.min(aw / w, ah / h);
  ox = ax + (aw - w * scale) / 2; oy = ay + (ah - h * scale) / 2;
}

// sprites de fuego pre-renderizados
function sprite(stops, size = 64) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"), r = size / 2;
  const grd = g.createRadialGradient(r, r, 0, r, r, r);
  stops.forEach(([o, col]) => grd.addColorStop(o, col));
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  return c;
}
// paleta dorada: champán → oro → bronce
const SPR = [
  sprite([[0, "rgba(255,253,240,1)"], [0.25, "rgba(255,240,190,.9)"], [1, "rgba(240,200,110,0)"]]),
  sprite([[0, "rgba(255,236,170,1)"], [0.3, "rgba(240,198,92,.8)"], [1, "rgba(212,160,40,0)"]]),
  sprite([[0, "rgba(232,190,90,.9)"], [0.4, "rgba(190,140,40,.55)"], [1, "rgba(130,90,20,0)"]]),
  sprite([[0, "rgba(120,88,30,.45)"], [1, "rgba(40,28,8,0)"]]),
];
const BEACON = sprite([[0, "rgba(255,255,255,1)"], [0.12, "rgba(255,255,255,1)"], [0.3, "rgba(255,246,214,.7)"], [0.6, "rgba(245,215,140,.2)"], [1, "rgba(240,200,110,0)"]], 128);
const GLOW = sprite([[0, "rgba(255,255,255,1)"], [0.15, "rgba(255,238,180,.95)"], [0.4, "rgba(230,190,90,.35)"], [1, "rgba(200,150,40,0)"]], 128);

// ---------- geometría del mapa ----------
let landPath, mask, maskW, maskH, maskScale = 0.4, ember, maskCtx;
let land = [], edge = [], landByY = [];

function buildGeometry() {
  const { w, h, countries } = S.map;
  landPath = new Path2D();
  countries.forEach((c, i) => {
    c.index = i;
    c.path = new Path2D();
    for (const ring of c.rings) {
      c.path.moveTo(ring[0][0], ring[0][1]);
      for (let k = 1; k < ring.length; k++) c.path.lineTo(ring[k][0], ring[k][1]);
      c.path.closePath();
    }
    landPath.addPath(c.path);
    if (!c.deco) S.byCode[c.code] = c;
  });
  S.countries = countries;

  // máscara: cada país pintado con su índice en el canal rojo
  maskW = Math.ceil(w * maskScale); maskH = Math.ceil(h * maskScale);
  const mc = document.createElement("canvas"); mc.width = maskW; mc.height = maskH;
  const m = maskCtx = mc.getContext("2d", { willReadFrequently: true });
  m.setTransform(maskScale, 0, 0, maskScale, 0, 0);
  countries.forEach((c, i) => { m.fillStyle = `rgb(${c.deco ? 250 : i + 1},0,0)`; m.fill(c.path); });
  const data = m.getImageData(0, 0, maskW, maskH).data;
  mask = new Int16Array(maskW * maskH).fill(-1);
  for (let i = 0; i < mask.length; i++) {
    if (data[i * 4 + 3] > 200) {
      // en los bordes el antialias mezcla índices: se confirma contra la forma real del país
      const v = data[i * 4] - 1, x = i % maskW, y = (i / maskW) | 0;
      mask[i] = countries[v] && !countries[v].deco && m.isPointInPath(countries[v].path, x + 0.5, y + 0.5) ? v : -2;
    }
  }
  // muestras de tierra
  const step = 2;
  for (let y = 0; y < maskH; y += step) for (let x = 0; x < maskW; x += step) {
    const v = mask[y * maskW + x];
    if (v !== -1) {
      const p = { x: (x + Math.random() * step) / maskScale, y: (y + Math.random() * step) / maskScale, c: v };
      land.push(p);
      if (v >= 0) (countries[v].samples ||= []).push(p);
    }
  }
  landByY = land.slice().sort((a, b) => a.y - b.y);
  for (const c of countries) for (const ring of c.rings) for (let k = 0; k < ring.length; k += 2) edge.push({ x: ring[k][0], y: ring[k][1] });

  // textura de brasas
  ember = document.createElement("canvas");
  ember.width = Math.ceil(w * 0.5); ember.height = Math.ceil(h * 0.5);
  const e = ember.getContext("2d");
  e.setTransform(0.5, 0, 0, 0.5, 0, 0);
  e.fillStyle = "#1f1606"; e.fill(landPath);
  e.save(); e.clip(landPath);
  e.globalCompositeOperation = "lighter";
  for (let i = 0; i < 2600; i++) {
    const p = land[(Math.random() * land.length) | 0];
    const r = 6 + Math.random() * 26;
    e.globalAlpha = 0.05 + Math.random() * 0.12;
    e.drawImage(SPR[Math.random() < 0.2 ? 1 : 2], p.x - r, p.y - r, r * 2, r * 2);
  }
  e.restore();
}

function countryAt(x, y) {
  const mx = Math.floor(x * maskScale), my = Math.floor(y * maskScale);
  if (mx < 0 || my < 0 || mx >= maskW || my >= maskH) return -1;
  return mask[my * maskW + mx];
}

// ---------- partículas ----------
const MAX = reduced ? 300 : mobile ? 900 : 2200;
const parts = [];
function spawn(x, y, o = {}) {
  if (parts.length >= MAX) return;
  const a = o.angle ?? -Math.PI / 2 + (Math.random() - 0.5) * 0.8;
  const sp = o.speed ?? 15 + Math.random() * 35;
  const life = o.life ?? 0.6 + Math.random() * 1.1;
  parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life, size: o.size ?? 5 + Math.random() * 9, rise: o.rise ?? 55 });
}
function burst(x, y, n = 80, power = 120) {
  for (let i = 0; i < n; i++) {
    spawn(x, y, { angle: Math.random() * Math.PI * 2, speed: Math.random() * power, life: 0.5 + Math.random() * 1.2, size: 3 + Math.random() * 8, rise: 25 });
  }
}

// efectos: anillos, haces y etiquetas
const fx = [];
function flare(x, y, label, big = true) {
  const t = performance.now() / 1000;
  fx.push({ kind: "ring", x, y, t, dur: 1.6, r: big ? 140 : 60 });
  if (big) {
    fx.push({ kind: "ring", x, y, t: t + 0.25, dur: 1.8, r: 220 });
    fx.push({ kind: "beam", x, y, t, dur: 2.6 });
  }
  if (label) fx.push({ kind: "label", x, y, t, dur: 5, text: label });
  if (big) {
    // la luz viaja hacia los builders más recientes: la red se conecta
    S.points.filter(p => p.x !== x || p.y !== y).slice(-6).forEach((p, i) =>
      fx.push({ kind: "arc", x, y, x2: p.x, y2: p.y, t: t + 0.3 + i * 0.12, dur: 2.8 }));
  }
  burst(x, y, big ? 140 : 40, big ? 170 : 90);
}

// ---------- puntos de builders ----------
function hash(str) { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function placePoint(b) {
  const c = S.byCode[b.country];
  if (!c || !c.samples?.length) return null;
  const s = c.samples[hash(b.id) % c.samples.length];
  return { id: b.id, x: s.x, y: s.y, country: b.country, born: performance.now() / 1000, phase: Math.random() * 6.28 };
}

// ---------- animación ----------
let introSeen = false;
try { introSeen = sessionStorage.getItem("intro") === "1"; } catch {}
const INTRO = reduced || introSeen ? 0 : 2.2;
let START = performance.now() / 1000 + 0.3 + INTRO;
const BURN = reduced ? 0.01 : 3.4;
const intro = $("#intro");
function endIntro() {
  if (!intro || intro.classList.contains("gone")) return;
  intro.classList.add("gone");
  START = Math.min(START, performance.now() / 1000 + 0.2);
  try { sessionStorage.setItem("intro", "1"); } catch {}
}
if (INTRO) { intro.hidden = false; intro.addEventListener("click", endIntro); setTimeout(endIntro, INTRO * 1000); }
let last = performance.now() / 1000, flash = null;

function frame() {
  const now = performance.now() / 1000, dt = Math.min(0.05, now - last); last = now;
  requestAnimationFrame(frame);
  if (!S.map || !heroVisible) return;
  const { w, h } = S.map;
  const p = Math.max(0, Math.min(1, (now - START) / BURN));
  const frontY = p * (h + 80) - 40;

  // paralaje suave
  const tx = mouse.x >= 0 ? (mouse.x - cw / 2) * -0.012 : 0, ty = mouse.y >= 0 ? (mouse.y - ch / 2) * -0.012 : 0;
  px += (tx - px) * 0.05; py += (ty - py) * 0.05;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cw, ch);
  const k = scale;
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (ox + px), dpr * (oy + py));

  // tierra apagada
  ctx.fillStyle = "#0e0b09"; ctx.fill(landPath);
  ctx.lineWidth = 1 / k; ctx.strokeStyle = "#2a2622"; ctx.stroke(landPath);

  // parte quemada
  ctx.save();
  ctx.beginPath(); ctx.rect(-50, -50, w + 100, frontY + 50); ctx.clip();
  ctx.globalAlpha = 0.75 + Math.sin(now * 3) * 0.08 + Math.sin(now * 7.3) * 0.04;
  ctx.drawImage(ember, 0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.shadowColor = "rgba(240,196,90,.9)"; ctx.shadowBlur = 14 * k * dpr;
  ctx.lineWidth = 1.6 / k; ctx.strokeStyle = `rgba(255,${222 + Math.sin(now * 4) * 14 | 0},${150 + Math.sin(now * 3) * 30 | 0},.95)`;
  ctx.stroke(landPath);
  ctx.restore();

  // país resaltado (hover o chip del directorio)
  const hi = flash && now - flash.t < 2.2 ? flash.c : mouse.country;
  if (hi >= 0) {
    const c = S.countries[hi];
    ctx.save();
    ctx.fillStyle = "rgba(245,200,100,.2)"; ctx.fill(c.path);
    ctx.shadowColor = "#ffe3a0"; ctx.shadowBlur = 18 * k * dpr;
    ctx.lineWidth = 2.4 / k; ctx.strokeStyle = "#fff1c9"; ctx.stroke(c.path);
    ctx.restore();
  }

  // generar llamas
  if (p < 1) {
    const lo = lowerBound(frontY - 30), hiI = lowerBound(frontY + 10);
    for (let i = 0; i < (mobile ? 25 : 70) && hiI > lo; i++) { const s = landByY[lo + ((Math.random() * (hiI - lo)) | 0)]; spawn(s.x, s.y, { size: 8 + Math.random() * 14 }); }
  } else {
    for (let i = 0; i < (mobile ? 3 : 7); i++) { const s = edge[(Math.random() * edge.length) | 0]; spawn(s.x, s.y, { size: 3 + Math.random() * 6, life: 0.5 + Math.random() * 0.8 }); }
    for (let i = 0; i < 2; i++) { const s = land[(Math.random() * land.length) | 0]; spawn(s.x, s.y, { size: 2 + Math.random() * 4, speed: 8, life: 1.4 }); }
  }
  if (mouse.inside && mouse.country !== -1) for (let i = 0; i < 5; i++) spawn(mouse.mx + (Math.random() - 0.5) * 16, mouse.my + (Math.random() - 0.5) * 16, { size: 6 + Math.random() * 10 });

  ctx.globalCompositeOperation = "lighter";

  // partículas
  for (let i = parts.length - 1; i >= 0; i--) {
    const q = parts[i];
    q.life -= dt;
    if (q.life <= 0) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
    q.vy -= q.rise * dt; q.vx += (Math.random() - 0.5) * 80 * dt; q.vx *= 0.98;
    q.x += q.vx * dt; q.y += q.vy * dt;
    const f = q.life / q.max;
    const spr = SPR[f > 0.75 ? 0 : f > 0.5 ? 1 : f > 0.25 ? 2 : 3];
    const sz = q.size * (0.4 + Math.sin(f * Math.PI) * 0.9);
    ctx.globalAlpha = Math.min(1, f * 1.3);
    ctx.drawImage(spr, q.x - sz, q.y - sz, sz * 2, sz * 2);
  }

  // builders
  ctx.strokeStyle = "#fff6e0";
  S.points.forEach((pt, i) => {
    const age = now - pt.born;
    if (age < 0) return;
    const intro = Math.min(1, age / 0.6);
    const pulse = 0.75 + Math.sin(now * 2.4 + pt.phase) * 0.25;
    const r = (20 + 10 * pulse) * intro * (age < 1.2 ? 1 + (1.2 - age) * 3 : 1);
    ctx.globalAlpha = 1;
    ctx.drawImage(BEACON, pt.x - r, pt.y - r, r * 2, r * 2);
    if (i < 400) {
      // onda que sale de cada punto, como un faro
      const a = ((now + pt.phase) % 3) / 3;
      ctx.globalAlpha = (1 - a) * 0.7;
      ctx.lineWidth = 1.5 / k;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 8 + a * 46, 0, Math.PI * 2); ctx.stroke();
    }
  });

  // quienes están mirando: chispas pálidas titilando en su país
  for (const [cc, n] of Object.entries(S.watching)) {
    const c = S.byCode[cc];
    if (!c?.samples?.length) continue;
    for (let i = 0; i < Math.min(n * 3, 24); i++) {
      const s = c.samples[(hash(cc + i) % c.samples.length)];
      const tw = 0.5 + 0.5 * Math.sin(now * (2 + (i % 5)) + i);
      const r = 5 + tw * 6;
      ctx.globalAlpha = 0.35 + tw * 0.5;
      ctx.drawImage(SPR[0], s.x - r, s.y - r, r * 2, r * 2);
    }
  }

  // efectos
  for (let i = fx.length - 1; i >= 0; i--) {
    const e = fx[i], a = (now - e.t) / e.dur;
    if (a < 0) continue;
    if (a >= 1) { fx.splice(i, 1); continue; }
    if (e.kind === "ring") {
      ctx.globalAlpha = (1 - a) * 0.9;
      ctx.lineWidth = (3 * (1 - a) + 0.5) / k;
      ctx.strokeStyle = "#ffe2a0";
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * easeOut(a), 0, Math.PI * 2); ctx.stroke();
    } else if (e.kind === "arc") {
      const mx = (e.x + e.x2) / 2, my = Math.min(e.y, e.y2) - Math.hypot(e.x2 - e.x, e.y2 - e.y) * 0.35;
      ctx.globalAlpha = (1 - a) * 0.55;
      ctx.lineWidth = 1.2 / k; ctx.strokeStyle = "#f3d58c";
      ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.quadraticCurveTo(mx, my, e.x2, e.y2); ctx.stroke();
      const t = Math.min(1, a * 1.8), u = 1 - t;
      const bx = u * u * e.x + 2 * u * t * mx + t * t * e.x2, by = u * u * e.y + 2 * u * t * my + t * t * e.y2;
      ctx.globalAlpha = 1 - a; ctx.drawImage(GLOW, bx - 14, by - 14, 28, 28);
    } else if (e.kind === "beam") {
      const g = ctx.createLinearGradient(e.x, e.y, e.x, e.y - 420);
      g.addColorStop(0, `rgba(255,236,180,${(1 - a) * 0.9})`); g.addColorStop(1, "rgba(220,170,60,0)");
      ctx.globalAlpha = 1; ctx.fillStyle = g;
      const bw = 6 * (1 - a) + 1;
      ctx.fillRect(e.x - bw / 2, e.y - 420, bw, 420);
    }
  }

  // etiquetas en coordenadas de pantalla
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  for (const e of fx) {
    if (e.kind !== "label") continue;
    const a = (now - e.t) / e.dur;
    if (a < 0) continue;
    const sx = ox + px + e.x * k, sy = oy + py + e.y * k - 26 - a * 30;
    ctx.globalAlpha = a < 0.1 ? a * 10 : a > 0.75 ? (1 - a) * 4 : 1;
    ctx.font = "600 14px Inter, sans-serif"; ctx.textAlign = "center";
    const tw = ctx.measureText(e.text).width + 20;
    ctx.fillStyle = "rgba(12,10,6,.9)"; roundRect(sx - tw / 2, sy - 18, tw, 26, 13); ctx.fill();
    ctx.strokeStyle = "rgba(240,200,110,.75)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "#fff4dc"; ctx.fillText(e.text, sx, sy);
  }
  ctx.globalAlpha = 1;
}
const easeOut = a => 1 - Math.pow(1 - a, 3);
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
function lowerBound(y) { let lo = 0, hi = landByY.length; while (lo < hi) { const m = (lo + hi) >> 1; landByY[m].y < y ? (lo = m + 1) : (hi = m); } return lo; }

// ---------- interacción con el mapa ----------
const tip = $("#tooltip");
function toMap(e) {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  return { x, y, mx: (x - ox - px) / scale, my: (y - oy - py) / scale };
}
canvas.addEventListener("pointermove", e => {
  const m = toMap(e);
  Object.assign(mouse, m, { inside: true, country: countryAt(m.mx, m.my) });
  const c = mouse.country >= 0 ? S.countries[mouse.country] : null;
  if (c) {
    const n = S.byCountry[c.code] || 0;
    const w = S.watching[c.code] || 0;
    tip.innerHTML = `<b>${flag(c.code)} ${esc(c.en)}</b><span>✦ ${n} in the directory${w ? ` · 👀 ${w} watching now` : ""}</span><span>click to send a spark · double-click to browse</span>`;
    tip.style.left = m.x + "px"; tip.style.top = m.y + "px"; tip.hidden = false;
  } else tip.hidden = true;
});
canvas.addEventListener("pointerleave", () => { mouse.inside = false; mouse.country = -1; mouse.x = mouse.y = -1; tip.hidden = true; });
canvas.addEventListener("click", e => {
  const m = toMap(e);
  const c = countryAt(m.mx, m.my);
  flare(m.mx, m.my, null, false);
  sendSpark(m.mx / S.map.w, m.my / S.map.h);
  if (c >= 0) { const sel = $("#country"); if (!sel.value) sel.value = S.countries[c].code; }
  if (c >= 0 && e.detail === 2) filterCountry(S.countries[c].code);
});

// ---------- WebSocket ----------
let ws, wsDelay = 1000;
function connect() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  ws.onopen = () => { wsDelay = 1000; };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "hello" || m.type === "presence") { setOnline(m.online); S.watching = m.watching || {}; }
    else if (m.type === "join") onJoin(m.builder, m.total);
    else if (m.type === "spark" && S.map) flare(m.x * S.map.w, m.y * S.map.h, null, false);
  };
  ws.onclose = () => { setTimeout(connect, wsDelay); wsDelay = Math.min(wsDelay * 2, 15000); };
}
function sendSpark(x, y) { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "spark", x, y })); }

function setOnline(n) { S.online = n; $("#online").textContent = n; $("#nav-online").textContent = n; }

function onJoin(b, total) {
  if (S.seen.has(b.id)) return;
  S.seen.add(b.id);
  S.byCountry[b.country] = (S.byCountry[b.country] || 0) + 1;
  S.total = total ?? S.total + 1;
  S.recent.unshift(b); S.recent = S.recent.slice(0, 30);
  const pt = placePoint(b);
  if (pt) {
    S.points.push(pt);
    const c = S.byCode[b.country];
    flare(pt.x, pt.y, `${flag(b.country)} ${b.name}${b.city ? " · " + b.city : ""}`);
    if (c) flash = { c: c.index, t: performance.now() / 1000 };
  }
  ticker(b);
  renderStats(); renderFeed(true); renderBoard(); renderChips();
  if (matchesFilter(b)) { dir.entries.unshift(b); renderDir(); }
}

// ---------- UI ----------
const cname = cc => S.byCode[cc]?.en || cc;
function countUp(el, to) {
  const from = Number(el.dataset.v || 0); el.dataset.v = to;
  if (reduced) { el.textContent = to.toLocaleString("en"); return; }
  const t0 = performance.now();
  const step = () => { const a = Math.min(1, (performance.now() - t0) / 900); el.textContent = Math.round(from + (to - from) * easeOut(a)).toLocaleString("en"); if (a < 1) requestAnimationFrame(step); };
  step();
}
function renderStats() {
  countUp($("#total"), S.total);
  countUp($("#countries-lit"), Object.values(S.byCountry).filter(n => n > 0).length);
}
const ago = ts => { const s = (Date.now() - ts) / 1000; return s < 60 ? "just now" : s < 3600 ? `${s / 60 | 0} min ago` : s < 86400 ? `${s / 3600 | 0} h ago` : `${s / 86400 | 0} d ago`; };
const safeUrl = u => /^https?:\/\//i.test(u || "") ? u : "";
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const subtitle = b => b.kind === "company" ? "Company" : b.company ? `@ ${b.company}` : "";

function renderFeed(isNew) {
  const ol = $("#feed");
  if (!S.recent.length) { ol.innerHTML = `<li class="empty">No one yet. Be the first to light up Latam ✦</li>`; return; }
  ol.innerHTML = S.recent.map((b, i) => `<li class="${isNew && i === 0 ? "new" : ""}"><span class="flag">${flag(b.country)}</span><div><b>${esc(b.name)}</b>${b.n ? ` <small class="mono">#${b.n}</small>` : ""}${subtitle(b) ? ` <em class="inline">${esc(subtitle(b))}</em>` : ""}<em>${esc([b.city, cname(b.country)].filter(Boolean).join(", "))} · ${ago(b.ts)}</em>${b.building ? `<em>✦ ${esc(b.building)}</em>` : ""}</div></li>`).join("");
}
function renderBoard() {
  const rows = Object.entries(S.byCountry).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = rows[0]?.[1] || 1;
  $("#board").innerHTML = rows.length ? rows.map(([cc, n]) => `<li title="${esc(cname(cc))}"><span>${flag(cc)}</span><div class="bar"><i style="width:${(n / max) * 100}%"></i></div><b>${n}</b></li>`).join("") : `<li class="empty" style="display:block;color:var(--mute)">No countries lit yet.</li>`;
}
function ticker(b) {
  const ol = $("#ticker");
  const li = document.createElement("li");
  li.innerHTML = `✦ <b>${esc(b.name)}</b> joined from ${flag(b.country)} ${esc(b.city || cname(b.country))}${b.building ? ` <em>· ${esc(b.building)}</em>` : ""}`;
  ol.prepend(li);
  while (ol.children.length > 4) ol.lastChild.remove();
  setTimeout(() => { li.classList.add("out"); setTimeout(() => li.remove(), 700); }, 7000);
}
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 4500); }

// ---------- directorio ----------
const dir = { entries: [], q: "", kind: "", country: "" };
const matchesFilter = b => (!dir.kind || b.kind === dir.kind) && (!dir.country || b.country === dir.country) &&
  (!dir.q || [b.name, b.company, b.building, b.city].join(" ").toLowerCase().includes(dir.q.toLowerCase()));

function renderChips() {
  const codes = S.countries.filter(c => !c.deco).map(c => c.code).sort((a, b) => (S.byCountry[b] || 0) - (S.byCountry[a] || 0) || cname(a).localeCompare(cname(b)));
  $("#country-chips").innerHTML = [`<li data-cc="" class="${dir.country ? "" : "on"}">All countries</li>`]
    .concat(codes.map(cc => { const n = S.byCountry[cc] || 0; return `<li data-cc="${cc}" class="${n ? "lit" : ""} ${dir.country === cc ? "on" : ""}">${flag(cc)} ${esc(cname(cc))}${n ? ` <small>${n}</small>` : ""}</li>`; })).join("");
}
function renderDir() {
  const ul = $("#dir");
  if (!dir.entries.length) {
    ul.innerHTML = `<li class="empty">${dir.q || dir.kind || dir.country ? "No matches yet." : "The directory is waiting for its first members."} <a href="#join">Join the directory</a></li>`;
    return;
  }
  ul.innerHTML = dir.entries.map(b => {
    const site = safeUrl(b.website);
    return `<li class="card">
      <div class="card-top"><span class="flag">${flag(b.country)}</span><span class="badge ${b.kind}">${b.kind === "company" ? "Company" : "Person"}</span><small class="mono">#${b.n}</small></div>
      <b>${esc(b.name)}</b>${b.kind === "person" && b.company ? `<span class="co">${esc(b.company)}</span>` : ""}
      ${b.building ? `<p>${esc(b.building)}</p>` : ""}
      <div class="card-foot"><span>${esc([b.city, cname(b.country)].filter(Boolean).join(", "))}</span>
        <span class="links">${site ? `<a href="${esc(site)}" target="_blank" rel="noopener nofollow">${esc(host(site))} ↗</a>` : ""}${b.handle ? `<a href="https://x.com/${encodeURIComponent(b.handle)}" target="_blank" rel="noopener nofollow">𝕏</a>` : ""}</span></div>
    </li>`;
  }).join("");
}
let dirTimer;
async function loadDir() {
  const qs = new URLSearchParams({ q: dir.q, kind: dir.kind, country: dir.country });
  try { dir.entries = (await fetch("/api/directory?" + qs).then(r => r.json())).entries || []; } catch { dir.entries = []; }
  renderDir();
}
function filterCountry(cc) {
  dir.country = cc; renderChips(); loadDir();
  if (cc) document.getElementById("directory").scrollIntoView({ behavior: "smooth" });
}
$("#q").addEventListener("input", e => { dir.q = e.target.value.trim(); clearTimeout(dirTimer); dirTimer = setTimeout(loadDir, 200); });
document.querySelectorAll('input[name="fkind"]').forEach(r => r.addEventListener("change", e => { dir.kind = e.target.value; loadDir(); }));
$("#country-chips").addEventListener("click", e => {
  const li = e.target.closest("li"); if (!li) return;
  const cc = li.dataset.cc;
  dir.country = cc; renderChips(); loadDir();
  const c = S.byCode[cc];
  if (c) flash = { c: c.index, t: performance.now() / 1000 };
});

// ---------- formulario ----------
const form = $("#form");
function syncKind() {
  const company = form.kind.value === "company";
  $("#name-label").textContent = company ? "Company name" : "Your name or username";
  form.name.placeholder = company ? "Acme AI" : "Ana Pérez or @ana";
  form.name.autocomplete = company ? "organization" : "nickname";
  $("#building-label").textContent = company ? "What does the company build?" : "What are you building?";
  form.querySelector(".person-only").hidden = company;
}
form.querySelectorAll('input[name="kind"]').forEach(r => r.addEventListener("change", syncKind));

form.addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("#form-msg"), btn = $("#submit");
  const data = Object.fromEntries(new FormData(form));
  msg.className = "form-msg"; msg.textContent = "";
  if (!data.name.trim() || !data.email.includes("@") || !data.country) { msg.className = "form-msg err"; msg.textContent = "Please add a name, email and country."; return; }
  btn.disabled = true; btn.textContent = "Joining…";
  try {
    const r = await fetch("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not register.");
    showDone(j.builder, j.existing);
    if (j.existing) return;
    form.reset(); syncKind();
    window.scrollTo({ top: 0, behavior: "smooth" });
    // si el socket no llegó, se pinta localmente
    setTimeout(() => onJoin(j.builder), 700);
    toast(`✦ ${j.builder.name} is now on the Latam/acc map`);
  } catch (err) {
    msg.className = "form-msg err"; msg.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = "Join the directory";
  }
});

function showDone(b, existing) {
  const text = `${b.kind === "company" ? `${b.name} is` : "I'm"} member #${b.n} of the Latam/acc directory ✦ AI companies and people building the golden era of Latin America:`;
  $("#done-n").textContent = "#" + b.n;
  $("#done-title").textContent = existing ? `${b.name} is already in the directory` : `${b.name}, you're on the map`;
  $("#done-share").href = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent("https://latamacc.si")}`;
  form.hidden = true; $("#done").hidden = false;
}
$("#done-again").addEventListener("click", () => { $("#done").hidden = true; form.hidden = false; $("#form-msg").textContent = ""; });

// ---------- merch (coming soon) ----------
const notify = $("#notify");
const ITEM_NAMES = { tee: "Tee", hoodie: "Hoodie", cap: "Cap", tote: "Tote" };
function pickItem(li) {
  document.querySelectorAll(".drop").forEach(d => d.classList.toggle("picked", d === li));
  notify.item.value = li.dataset.item;
  $("#notify-item").textContent = ITEM_NAMES[li.dataset.item];
}
document.querySelectorAll(".drop").forEach(li => {
  li.addEventListener("click", () => { pickItem(li); li.querySelector(".flip")?.classList.toggle("turned"); });
  li.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); li.click(); } });
  // inclinación 3D siguiendo el cursor
  li.addEventListener("pointermove", e => {
    if (reduced) return;
    const r = li.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    li.style.setProperty("--rx", `${-y * 10}deg`); li.style.setProperty("--ry", `${x * 14}deg`);
    li.style.setProperty("--gx", `${(x + 0.5) * 100}%`); li.style.setProperty("--gy", `${(y + 0.5) * 100}%`);
  });
  li.addEventListener("pointerleave", () => { li.style.setProperty("--rx", "0deg"); li.style.setProperty("--ry", "0deg"); });
});
pickItem(document.querySelector(".drop"));
notify.addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("#notify-msg"), btn = $("#notify-btn");
  const data = Object.fromEntries(new FormData(notify));
  msg.className = "form-msg"; msg.textContent = "";
  if (!data.email.includes("@")) { msg.className = "form-msg err"; msg.textContent = "Please add your email."; return; }
  btn.disabled = true;
  try {
    const r = await fetch("/api/merch/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not save.");
    msg.className = "form-msg ok"; msg.textContent = `You're on the list for the ${ITEM_NAMES[data.item]} ✦ We'll email you when the drop is live.`;
    notify.email.value = "";
  } catch (err) {
    msg.className = "form-msg err"; msg.textContent = err.message;
  } finally { btn.disabled = false; }
});

// ---------- arranque ----------
const io = new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return;
  e.target.classList.add("in");
  io.unobserve(e.target);
}), { threshold: 0.15 });
document.querySelectorAll(".reveal").forEach(el => io.observe(el));
new IntersectionObserver(([e]) => { heroVisible = e.isIntersecting; }).observe($(".hero"));

const clock = () => { $("#clock").textContent = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Bogota", hour12: false }) + " BOG"; };
clock(); setInterval(clock, 1000);
setInterval(() => renderFeed(false), 60_000);

addEventListener("resize", layout);

(async () => {
  const [map, state] = await Promise.all([
    fetch("/assets/latam.json").then(r => r.json()),
    fetch("/api/state").then(r => r.json()).catch(() => ({ total: 0, byCountry: {}, recent: [], points: [], online: 1 })),
  ]);
  S.map = map; buildGeometry(); layout();
  const sel = $("#country");
  S.countries.filter(c => !c.deco).sort((a, b) => a.en.localeCompare(b.en)).forEach(c => sel.add(new Option(`${flag(c.code)} ${c.en}`, c.code)));

  S.total = state.total; S.byCountry = state.byCountry; S.recent = state.recent; S.watching = state.watching || {};
  setOnline(state.online || 1);
  if (state.you && S.byCode[state.you] && !sel.value) sel.value = state.you;
  // los miembros existentes se encienden en cascada cuando termina el dorado
  const base = START + BURN;
  state.points.slice().reverse().forEach((b, i, arr) => {
    S.seen.add(b.id);
    const pt = placePoint(b);
    if (pt) { pt.born = base + (i / Math.max(1, arr.length)) * Math.min(3, arr.length * 0.15); S.points.push(pt); }
  });
  renderStats(); renderFeed(false); renderBoard(); renderChips(); syncKind();
  loadDir();
  connect();
  requestAnimationFrame(frame);
})();
