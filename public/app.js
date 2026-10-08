// latamacc.si — mapa de Latam en llamas + registros en vivo por WebSocket.

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
const SPR = [
  sprite([[0, "rgba(255,255,235,1)"], [0.25, "rgba(255,230,140,.9)"], [1, "rgba(255,150,30,0)"]]),
  sprite([[0, "rgba(255,220,120,1)"], [0.3, "rgba(255,150,40,.8)"], [1, "rgba(255,80,0,0)"]]),
  sprite([[0, "rgba(255,140,40,.9)"], [0.4, "rgba(230,60,10,.6)"], [1, "rgba(160,20,0,0)"]]),
  sprite([[0, "rgba(140,40,10,.5)"], [1, "rgba(40,10,0,0)"]]),
];
const BEACON = sprite([[0, "rgba(255,255,255,1)"], [0.12, "rgba(255,255,255,1)"], [0.3, "rgba(255,244,214,.65)"], [0.6, "rgba(255,210,150,.18)"], [1, "rgba(255,200,120,0)"]], 128);
const GLOW = sprite([[0, "rgba(255,255,255,1)"], [0.15, "rgba(255,220,130,.95)"], [0.4, "rgba(255,130,30,.35)"], [1, "rgba(255,80,0,0)"]], 128);

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
  e.fillStyle = "#2b0b03"; e.fill(landPath);
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
  ctx.shadowColor = "rgba(255,110,20,.9)"; ctx.shadowBlur = 14 * k * dpr;
  ctx.lineWidth = 1.6 / k; ctx.strokeStyle = `rgba(255,${150 + Math.sin(now * 5) * 30 | 0},50,.95)`;
  ctx.stroke(landPath);
  ctx.restore();

  // país resaltado (hover o chip del tweet)
  const hi = flash && now - flash.t < 2.2 ? flash.c : mouse.country;
  if (hi >= 0) {
    const c = S.countries[hi];
    ctx.save();
    ctx.fillStyle = "rgba(255,130,30,.22)"; ctx.fill(c.path);
    ctx.shadowColor = "#ffcf70"; ctx.shadowBlur = 18 * k * dpr;
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
      ctx.strokeStyle = "#ffcf70";
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * easeOut(a), 0, Math.PI * 2); ctx.stroke();
    } else if (e.kind === "arc") {
      const mx = (e.x + e.x2) / 2, my = Math.min(e.y, e.y2) - Math.hypot(e.x2 - e.x, e.y2 - e.y) * 0.35;
      ctx.globalAlpha = (1 - a) * 0.55;
      ctx.lineWidth = 1.2 / k; ctx.strokeStyle = "#ffd28a";
      ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.quadraticCurveTo(mx, my, e.x2, e.y2); ctx.stroke();
      const t = Math.min(1, a * 1.8), u = 1 - t;
      const bx = u * u * e.x + 2 * u * t * mx + t * t * e.x2, by = u * u * e.y + 2 * u * t * my + t * t * e.y2;
      ctx.globalAlpha = 1 - a; ctx.drawImage(GLOW, bx - 14, by - 14, 28, 28);
    } else if (e.kind === "beam") {
      const g = ctx.createLinearGradient(e.x, e.y, e.x, e.y - 420);
      g.addColorStop(0, `rgba(255,220,140,${(1 - a) * 0.9})`); g.addColorStop(1, "rgba(255,120,30,0)");
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
    ctx.fillStyle = "rgba(14,9,6,.88)"; roundRect(sx - tw / 2, sy - 18, tw, 26, 13); ctx.fill();
    ctx.strokeStyle = "rgba(255,160,60,.7)"; ctx.lineWidth = 1; ctx.stroke();
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
    tip.innerHTML = `<b>${flag(c.code)} ${esc(c.es)}</b><span>🔥 ${n} builder${n === 1 ? "" : "s"}${w ? ` · 👀 ${w} mirando ahora` : ""}</span><span>clic = chispa para todos</span>`;
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
}

// ---------- UI ----------
function countUp(el, to) {
  const from = Number(el.dataset.v || 0); el.dataset.v = to;
  if (reduced) { el.textContent = to.toLocaleString("es"); return; }
  const t0 = performance.now();
  const step = () => { const a = Math.min(1, (performance.now() - t0) / 900); el.textContent = Math.round(from + (to - from) * easeOut(a)).toLocaleString("es"); if (a < 1) requestAnimationFrame(step); };
  step();
}
function renderStats() {
  countUp($("#total"), S.total);
  countUp($("#countries-lit"), Object.values(S.byCountry).filter(n => n > 0).length);
}
const ago = ts => { const s = (Date.now() - ts) / 1000; return s < 60 ? "ahora" : s < 3600 ? `hace ${s / 60 | 0} min` : s < 86400 ? `hace ${s / 3600 | 0} h` : `hace ${s / 86400 | 0} d`; };
function renderFeed(isNew) {
  const ol = $("#feed");
  if (!S.recent.length) { ol.innerHTML = `<li class="empty">Nadie todavía. Sé el primero en encender Latam 🔥</li>`; return; }
  ol.innerHTML = S.recent.map((b, i) => `<li class="${isNew && i === 0 ? "new" : ""}"><span class="flag">${flag(b.country)}</span><div><b>${esc(b.name)}</b>${b.n ? ` <small class="mono">#${b.n}</small>` : ""}${b.handle ? ` <a href="https://x.com/${encodeURIComponent(b.handle)}" target="_blank" rel="noopener">@${esc(b.handle)}</a>` : ""}<em>${esc([b.city, S.byCode[b.country]?.es].filter(Boolean).join(", "))} · ${ago(b.ts)}</em>${b.building ? `<em>⚡ ${esc(b.building)}</em>` : ""}</div></li>`).join("");
}
function renderBoard() {
  const rows = Object.entries(S.byCountry).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = rows[0]?.[1] || 1;
  $("#board").innerHTML = rows.length ? rows.map(([cc, n]) => `<li><span>${flag(cc)}</span><div class="bar"><i style="width:${(n / max) * 100}%"></i></div><b>${n}</b></li>`).join("") : `<li class="empty" style="display:block;color:var(--mute)">Aún sin países encendidos.</li>`;
}
function ticker(b) {
  const ol = $("#ticker");
  const li = document.createElement("li");
  li.innerHTML = `🔥 <b>${esc(b.name)}</b> se encendió en ${flag(b.country)} ${esc(b.city || S.byCode[b.country]?.es || "")}${b.building ? ` <em>· ${esc(b.building)}</em>` : ""}`;
  ol.prepend(li);
  while (ol.children.length > 4) ol.lastChild.remove();
  setTimeout(() => { li.classList.add("out"); setTimeout(() => li.remove(), 700); }, 7000);
}
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 4500); }

// ---------- tweet de César ----------
const TWEET_EN = [
  "Gained 1000 new followers and 1 million views in the past days",
  "Trillions of dollars will be unlocked in this region, this post has been liked by builders from all Latam nationalities, we all speak Spanish and Portuguese is quite similar, we all share the same culture, we all been undervalued by the global market, we have been the underdogs for a long time, but here we have a whole new generation of makers, people that use more and more ai, minimum $1000 dollars per month, others are spending $20.000 per month, the acceleration is here, and people are using it to make things faster and better and come up with way more ideias that we ever came in our life, creativity golden era",
  "This truly is a whole new generation of makers that don’t complain that the labs and the platforms are moving too fast, that they are moving faster that consumers are able to use all the new stuff, NO!!! this Latam crowd doesn’t complain, we accelerate and we learn to be FAST",
  "This is Latam/acc, and we are making noise! Our brothers from North America are watching and getting ready to deploy real capital to scale whatever good stuff you cook",
  "Cheers to my hermanos y hermanas from all these countries, we are just getting started",
];
const TWEET_ES = [
  "Gané 1.000 seguidores nuevos y 1 millón de vistas en los últimos días",
  "Billones de dólares se van a desbloquear en esta región. A este post le dieron like builders de todas las nacionalidades de Latam: todos hablamos español y el portugués es muy parecido, compartimos la misma cultura y el mercado global nos ha subvalorado. Fuimos los underdogs por mucho tiempo, pero aquí hay una generación completamente nueva de makers, gente que usa cada vez más IA, mínimo US$1.000 al mes, otros gastan US$20.000 al mes. La aceleración llegó y la gente la usa para hacer cosas más rápido y mejor, y para tener muchas más ideas que nunca. La era dorada de la creatividad.",
  "Es una generación de makers que no se queja de que los labs y las plataformas avancen demasiado rápido, más rápido de lo que los consumidores alcanzan a usar todo lo nuevo. ¡NO! Esta gente de Latam no se queja: aceleramos y aprendemos a ser RÁPIDOS.",
  "Esto es Latam/acc, ¡y estamos haciendo ruido! Nuestros hermanos de Norteamérica están mirando y alistándose para desplegar capital real para escalar lo bueno que cocines.",
  "Salud a mis hermanos y hermanas de todos estos países, apenas estamos empezando.",
];
const HOT = /^(latam\/acc|acceleration|accelerate|aceleración|aceleramos|fast|rápidos|makers|creativity|creatividad|golden|dorada|trillions|billones|noise|ruido|capital)[,.!]*$/i;
const TWEET_COUNTRIES = ["MX", "BZ", "CR", "SV", "GT", "HN", "NI", "PA", "AR", "BO", "BR", "CL", "CO", "EC", "GY", "PY", "PE", "SR", "UY", "VE", "CU", "DO", "PR", "HT"];
let tweetLang = "en", typing = null, tweetShown = false;

function renderTweet(animate) {
  const body = $("#tweet-body");
  const paras = tweetLang === "en" ? TWEET_EN : TWEET_ES;
  body.innerHTML = paras.map(p => `<p>${p.split(/\s+/).map(w => `<span class="w${HOT.test(w) ? " hot" : ""}">${esc(w)}</span>`).join(" ")}</p>`).join("");
  const words = [...body.querySelectorAll(".w")];
  clearInterval(typing);
  if (!animate || reduced) { words.forEach(w => w.classList.add("on")); return; }
  let i = 0;
  typing = setInterval(() => { for (let k = 0; k < 3 && i < words.length; k++) words[i++].classList.add("on"); if (i >= words.length) clearInterval(typing); }, 28);
}
function renderChips() {
  $("#tweet-countries").innerHTML = TWEET_COUNTRIES.map(cc => {
    const c = S.byCode[cc]; const n = S.byCountry[cc] || 0;
    return `<li data-cc="${cc}" class="${n ? "lit" : ""}">${flag(cc)} ${esc(tweetLang === "en" ? c?.en : c?.es)}${n ? ` <small>${n}</small>` : ""}</li>`;
  }).join("");
}
$("#tweet-countries").addEventListener("click", e => {
  const li = e.target.closest("li"); if (!li) return;
  const c = S.byCode[li.dataset.cc]; if (!c) return;
  $("#country").value = c.code;
  window.scrollTo({ top: 0, behavior: "smooth" });
  setTimeout(() => {
    flash = { c: c.index, t: performance.now() / 1000 };
    const s = c.samples?.[0]; if (s) { const m = c.centroid; flare(m[0], m[1], `${flag(c.code)} ${c.es}`, false); }
  }, 500);
});
$("#translate").addEventListener("click", () => {
  tweetLang = tweetLang === "en" ? "es" : "en";
  $("#translate").textContent = tweetLang === "en" ? "Traducir al español" : "Ver original";
  renderTweet(false); renderChips();
});

// ---------- formulario ----------
const form = $("#form");
form.addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("#form-msg"), btn = $("#submit");
  const data = Object.fromEntries(new FormData(form));
  msg.className = "form-msg"; msg.textContent = "";
  if (!data.name.trim() || !data.email.includes("@") || !data.country) { msg.className = "form-msg err"; msg.textContent = "Completa nombre, correo y país."; return; }
  btn.disabled = true; btn.textContent = "Encendiendo…";
  try {
    const r = await fetch("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "No se pudo registrar.");
    showDone(j.builder, j.existing);
    if (j.existing) return;
    form.reset();
    window.scrollTo({ top: 0, behavior: "smooth" });
    // si el socket no llegó, se pinta localmente
    setTimeout(() => onJoin(j.builder), 700);
    toast(`🔥 ${j.builder.name}, ya estás en el mapa de Latam/acc`);
  } catch (err) {
    msg.className = "form-msg err"; msg.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = "🔥 Encender mi punto";
  }
});

function showDone(b, existing) {
  const text = `Soy el builder #${b.n} de Latam/acc 🔥 Enciende tu punto en el mapa de Latam:`;
  const url = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent("https://latamacc.si")}&via=cesarsuarezpab`;
  $("#done-n").textContent = "#" + b.n;
  $("#done-title").textContent = existing ? `${b.name}, ya estabas encendido` : `${b.name}, ya estás en el mapa`;
  $("#done-share").href = url;
  form.hidden = true; $("#done").hidden = false;
}
$("#done-again").addEventListener("click", () => { $("#done").hidden = true; form.hidden = false; $("#form-msg").textContent = ""; });

// ---------- arranque ----------
const io = new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return;
  e.target.classList.add("in");
  if (e.target.id === "tweet") { tweetShown = true; renderTweet(true); }
  io.unobserve(e.target);
}), { threshold: 0.15 });
document.querySelectorAll(".reveal").forEach(el => io.observe(el));
new IntersectionObserver(([e]) => { heroVisible = e.isIntersecting; }).observe($(".hero"));

const clock = () => { $("#clock").textContent = new Date().toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour12: false }) + " BOG"; };
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
  S.countries.filter(c => !c.deco).sort((a, b) => a.es.localeCompare(b.es, "es")).forEach(c => sel.add(new Option(`${flag(c.code)} ${c.es}`, c.code)));

  S.total = state.total; S.byCountry = state.byCountry; S.recent = state.recent; S.watching = state.watching || {};
  setOnline(state.online || 1);
  if (state.you && S.byCode[state.you] && !sel.value) sel.value = state.you;
  // los registros existentes se encienden en cascada cuando termina el fuego
  const base = START + BURN;
  state.points.slice().reverse().forEach((b, i, arr) => {
    S.seen.add(b.id);
    const pt = placePoint(b);
    if (pt) { pt.born = base + (i / Math.max(1, arr.length)) * Math.min(3, arr.length * 0.15); S.points.push(pt); }
  });
  renderStats(); renderFeed(false); renderBoard(); renderChips();
  if (!tweetShown) renderTweet(false), $("#tweet-body").querySelectorAll(".w").forEach(w => w.classList.remove("on"));
  connect();
  requestAnimationFrame(frame);
})();
