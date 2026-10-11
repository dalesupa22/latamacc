// latamacc.si — mapa de Latam en oro (golden era) + directorio en vivo por WebSocket.

const $ = s => document.querySelector(s);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const mobile = matchMedia("(max-width: 900px)").matches;
const flag = cc => String.fromCodePoint(...[...cc].map(c => 0x1f1a5 + c.charCodeAt(0)));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- estado ----------
const S = {
  map: null, countries: [], byCode: {}, total: 0, byCountry: {}, online: 1,
  points: [], seen: new Set(), recent: [], watching: {}, growth: [], kinds: {},
};

// ---------- canvas ----------
const canvas = $("#map");
const ctx = canvas.getContext("2d");
let dpr = 1, cw = 0, ch = 0, scale = 1, ox = 0, oy = 0, px = 0, py = 0;
let mouse = { x: -1, y: -1, mx: -1, my: -1, inside: false, country: -1, point: null };
let heroVisible = true;
// cámara: k = escala efectiva, x/y = desplazamiento; t* = destino. focus = país explorado (-1 = todo Latam)
const cam = { k: 1, x: 0, y: 0, tk: 1, tx: 0, ty: 0, ready: false };
let focus = -1, hoverId = null;

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
  camTarget();
  if (!cam.ready) { Object.assign(cam, { k: cam.tk, x: cam.tx, y: cam.ty, ready: true }); }
}
function camTarget() {
  if (focus < 0) { Object.assign(cam, { tk: scale, tx: ox, ty: oy }); return; }
  const b = S.countries[focus].bbox;
  let ax, ay, aw, ah;
  if (cw > 900) { ax = cw * 0.36; ay = 90; aw = cw - ax - 400; ah = ch - 130; }
  else { ax = 16; ay = 70; aw = cw - 32; ah = ch * 0.4; }
  const k = Math.max(scale, Math.min(aw / b.w, ah / b.h, scale * 8) * 0.85);
  Object.assign(cam, { tk: k, tx: ax + aw / 2 - (b.x + b.w / 2) * k, ty: ay + ah / 2 - (b.y + b.h / 2) * k });
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
    const boxes = c.rings.map(r => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      return { x0, y0, x1, y1, a: (x1 - x0) * (y1 - y0) }; });
    const big = Math.max(...boxes.map(b => b.a));
    const main = boxes.filter(b => b.a >= big * 0.08);
    const x0 = Math.min(...main.map(b => b.x0)), y0 = Math.min(...main.map(b => b.y0));
    c.bbox = { x: x0, y: y0, w: Math.max(20, Math.max(...main.map(b => b.x1)) - x0), h: Math.max(20, Math.max(...main.map(b => b.y1)) - y0) };
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
const countriesOf = b => [b.country, ...(b.also || [])];
function placePoint(b, cc = b.country) {
  const c = S.byCode[cc];
  if (!c || !c.samples?.length) return null;
  const s = c.samples[hash(b.id + (cc === b.country ? "" : cc)) % c.samples.length];
  // en otro país la ciudad no aplica
  return { id: b.id, name: b.name, kind: b.kind, city: cc === b.country ? b.city : "", x: s.x, y: s.y, country: cc, born: performance.now() / 1000, phase: Math.random() * 6.28 };
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

  const ease = reduced ? 1 : 1 - Math.pow(0.02, dt);
  cam.k += (cam.tk - cam.k) * ease; cam.x += (cam.tx - cam.x) * ease; cam.y += (cam.ty - cam.y) * ease;
  const zoom = cam.k / scale, shrink = Math.pow(zoom, 0.75);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cw, ch);
  const k = cam.k;
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (cam.x + px), dpr * (cam.y + py));

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

  // el país explorado queda encendido y el resto se apaga
  if (focus >= 0) {
    const c = S.countries[focus];
    c.dim ||= (() => { const d = new Path2D(landPath); d.addPath(c.path); return d; })();
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fill(c.dim, "evenodd");
    ctx.shadowColor = "#ffe3a0"; ctx.shadowBlur = 24 * dpr;
    ctx.lineWidth = 2.4 / k; ctx.strokeStyle = "#fff1c9"; ctx.stroke(c.path);
    ctx.restore();
  }

  // país resaltado (hover o chip del directorio)
  const hi = flash && now - flash.t < 2.2 ? flash.c : mouse.country;
  if (hi >= 0 && hi !== focus) {
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

  // builders: con muchos miembros las luces se achican para que el mapa no se sature de blanco
  const dens = Math.max(0.42, Math.min(1, Math.sqrt(70 / Math.max(70, S.points.length))));
  ctx.strokeStyle = "#fff6e0";
  S.points.forEach((pt, i) => {
    const age = now - pt.born;
    if (age < 0) return;
    const intro = Math.min(1, age / 0.6);
    const pulse = 0.75 + Math.sin(now * 2.4 + pt.phase) * 0.25;
    const r = (20 + 10 * pulse) * intro * (age < 1.2 ? 1 + (1.2 - age) * 3 : dens) / shrink;
    ctx.globalAlpha = 1;
    ctx.drawImage(BEACON, pt.x - r, pt.y - r, r * 2, r * 2);
    if (pt === mouse.point || pt.id === hoverId) {
      const g = 70 / shrink;
      ctx.drawImage(GLOW, pt.x - g, pt.y - g, g * 2, g * 2);
    }
    if (i < 400) {
      // onda que sale de cada punto, como un faro
      const a = ((now + pt.phase) % 3) / 3;
      ctx.globalAlpha = (1 - a) * 0.7;
      ctx.lineWidth = 1.5 / k;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, (8 + a * 46) * dens / shrink, 0, Math.PI * 2); ctx.stroke();
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
    const sx = cam.x + px + e.x * k, sy = cam.y + py + e.y * k - 26 - a * 30;
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
  return { x, y, mx: (x - cam.x - px) / cam.k, my: (y - cam.y - py) / cam.k };
}
// la luz más cercana al cursor (radio fijo en pantalla)
function pointAt(mx, my) {
  const now = performance.now() / 1000;
  let best = null, bd = (16 / cam.k) ** 2;
  for (const p of S.points) {
    if (p.born > now) continue;
    const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
canvas.addEventListener("pointermove", e => {
  if (!S.map) return;
  const m = toMap(e);
  Object.assign(mouse, m, { inside: true, country: countryAt(m.mx, m.my), point: pointAt(m.mx, m.my) });
  canvas.classList.toggle("on-point", !!mouse.point || mouse.country >= 0);
  const p = mouse.point, c = mouse.country >= 0 ? S.countries[mouse.country] : null;
  if (p) {
    tip.innerHTML = `<b>${flag(p.country)} ${esc(p.name || "Builder")}</b><span>${p.kind === "company" ? "Company" : "Person"} · ${esc(p.city || cname(p.country))}</span><span>click to see who it is</span>`;
  } else if (c) {
    const n = S.byCountry[c.code] || 0;
    const w = S.watching[c.code] || 0;
    tip.innerHTML = `<b>${flag(c.code)} ${esc(c.en)}</b><span>✦ ${n} in the directory${w ? ` · 👀 ${w} watching now` : ""}</span><span>${focus === c.index ? "click a light to see who it is" : "click to explore"}</span>`;
  }
  if (p || c) { tip.style.left = m.x + "px"; tip.style.top = m.y + "px"; tip.hidden = false; } else tip.hidden = true;
});
canvas.addEventListener("pointerleave", () => { Object.assign(mouse, { inside: false, country: -1, point: null, x: -1, y: -1 }); tip.hidden = true; });
canvas.addEventListener("click", e => {
  if (!S.map) return;
  const m = toMap(e);
  const p = pointAt(m.mx, m.my);
  const c = countryAt(m.mx, m.my);
  flare(p ? p.x : m.mx, p ? p.y : m.my, null, false);
  sendSpark(m.mx / S.map.w, m.my / S.map.h);
  if (p) openCountry(p.country, p.id);
  else if (c >= 0) openCountry(S.countries[c].code);
  else if (focus >= 0) closeCountry();
});

// ---------- explorar un país ----------
const hero = $(".hero"), cpanel = $("#cpanel");
let panelSeq = 0, panelCC = "";
async function openCountry(cc, id = null) {
  const c = S.byCode[cc];
  if (!c) return;
  const changed = panelCC !== cc;
  panelCC = cc; focus = c.index; camTarget();
  hero.classList.add("focused"); cpanel.hidden = false; tip.hidden = true;
  $("#cp-title").textContent = `${flag(cc)} ${c.en}`;
  const n = S.byCountry[cc] || 0, w = S.watching[cc] || 0;
  $("#cp-stats").textContent = `✦ ${n} in the directory${w ? ` · 👀 ${w} watching now` : ""}`;
  $("#cp-join").textContent = `Join from ${c.en}`;
  $("#cp-all").hidden = !n;
  const list = $("#cp-list");
  if (changed) list.innerHTML = `<li class="empty">Loading…</li>`;
  const seq = ++panelSeq;
  let entries = [];
  try { entries = (await fetch("/api/directory?" + new URLSearchParams({ country: cc })).then(r => r.json())).entries || []; } catch {}
  if (seq !== panelSeq) return;
  list.innerHTML = entries.length ? entries.map(b => {
    const site = safeUrl(b.website);
    return `<li data-id="${esc(b.id)}"><button type="button" data-id="${esc(b.id)}">
        <b>${esc(b.name)} <small class="mono">#${b.n}</small></b>
        <em>${b.kind === "company" ? "Company" : b.company ? `Person @ ${esc(b.company)}` : "Person"}${b.country !== cc ? ` · based in ${flag(b.country)} ${esc(cname(b.country))}` : b.city ? ` · ${esc(b.city)}` : ""}${b.also?.length && b.country === cc ? ` · also in ${b.also.map(flag).join(" ")}` : ""}</em>
        ${b.building ? `<p>✦ ${esc(b.building)}</p>` : ""}
      </button><span class="links">${site ? `<a href="${esc(site)}" target="_blank" rel="noopener nofollow" aria-label="${esc(host(site))}">↗</a>` : ""}${b.handle ? `<a href="https://x.com/${encodeURIComponent(b.handle)}" target="_blank" rel="noopener nofollow" aria-label="@${esc(b.handle)} on X">𝕏</a>` : ""}</span></li>`;
  }).join("") : `<li class="empty">No one in ${esc(c.en)} yet. Be the first to light it up ✦</li>`;
  if (id) selectMember(id);
}
function selectMember(id) {
  const li = [...$("#cp-list").children].find(l => l.dataset.id === id);
  $("#cp-list").querySelectorAll("li.on").forEach(l => l.classList.remove("on"));
  if (li) { li.classList.add("on"); li.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" }); }
}
function closeCountry() {
  focus = -1; panelCC = ""; hoverId = null; panelSeq++; camTarget();
  hero.classList.remove("focused"); cpanel.hidden = true;
}
$("#cp-close").addEventListener("click", closeCountry);
addEventListener("keydown", e => { if (e.key === "Escape" && focus >= 0) closeCountry(); });
$("#cp-join").addEventListener("click", () => { if (panelCC) $("#country").value = panelCC; });
$("#cp-all").addEventListener("click", () => filterCountry(panelCC));
$("#cp-list").addEventListener("pointerover", e => { hoverId = e.target.closest("li")?.dataset.id || null; });
$("#cp-list").addEventListener("pointerleave", () => { hoverId = null; });
$("#cp-list").addEventListener("click", e => {
  const id = e.target.closest("button")?.dataset.id;
  const p = id && S.points.find(q => q.id === id);
  if (!p) return;
  selectMember(id);
  const li = e.target.closest("li");
  flare(p.x, p.y, `${flag(p.country)} ${p.name}`, false);
  hoverId = id; if (li) li.classList.add("on");
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
    else if (m.type === "update" || m.type === "remove") { refreshState(); loadDir(); if (m.type === "remove") { loadJobs(); loadBounties(); } }
    else if (m.type === "jobs") { loadJobs(); patchEntry(m.builder); }
    else if (m.type === "bounties") loadBounties();
    else if (m.type === "spark" && S.map) flare(m.x * S.map.w, m.y * S.map.h, null, false);
  };
  ws.onclose = () => { setTimeout(connect, wsDelay); wsDelay = Math.min(wsDelay * 2, 15000); };
}
function sendSpark(x, y) { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "spark", x, y })); }

function setOnline(n) { S.online = n; $("#online").textContent = n; $("#nav-online").textContent = n; }

function onJoin(b, total) {
  if (S.seen.has(b.id)) return;
  S.seen.add(b.id);
  for (const cc of countriesOf(b)) S.byCountry[cc] = (S.byCountry[cc] || 0) + 1;
  S.total = total ?? S.total + 1;
  const today = bogotaDay(Date.now()), last = S.growth[S.growth.length - 1];
  if (last?.[0] === today) last[1]++; else S.growth.push([today, 1]);
  S.kinds[b.kind] = (S.kinds[b.kind] || 0) + 1;
  S.recent.unshift(b); S.recent = S.recent.slice(0, 30);
  for (const cc of (b.also || [])) { const extra = placePoint(b, cc); if (extra) S.points.push(extra); }
  const pt = placePoint(b);
  if (pt) {
    S.points.push(pt);
    const c = S.byCode[b.country];
    flare(pt.x, pt.y, `${flag(b.country)} ${b.name}${b.city ? " · " + b.city : ""}`);
    if (c) flash = { c: c.index, t: performance.now() / 1000 };
  }
  ticker(b);
  renderStats(); renderFeed(true); renderBoard(); renderGrowth(); renderChips();
  if (countriesOf(b).includes(panelCC)) openCountry(panelCC);
  if (matchesFilter(b)) { dir.entries.unshift(b); dir.count++; renderDir(); }
}

// un perfil editado o eliminado: se recargan conteos y luces sin reiniciar el mapa
async function refreshState() {
  let st;
  try { st = await fetch("/api/state").then(r => r.json()); } catch { return; }
  Object.assign(S, { total: st.total, byCountry: st.byCountry, recent: st.recent, growth: st.growth || [] });
  const want = new Map();
  for (const b of st.points) for (const cc of countriesOf(b)) want.set(`${b.id}|${cc}`, b);
  S.points = S.points.filter(p => { const b = want.get(`${p.id}|${p.country}`); if (b) { p.name = b.name; p.kind = b.kind; p.city = p.country === b.country ? b.city : ""; } return !!b; });
  const have = new Set(S.points.map(p => `${p.id}|${p.country}`));
  for (const [key, b] of want) if (!have.has(key)) { const pt = placePoint(b, key.split("|")[1]); if (pt) S.points.push(pt); }
  S.seen = new Set(st.points.map(b => b.id));
  renderStats(); renderFeed(false); renderBoard(); renderGrowth(); renderChips();
  if (panelCC) openCountry(panelCC);
}
function patchEntry(b) {
  if (!b) return;
  const i = dir.entries.findIndex(e => e.id === b.id);
  if (i >= 0) { dir.entries[i] = b; renderDir(); }
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
const mediaUrl = u => /^\/media\/avatars\/[0-9a-f/-]+\.(png|jpg|webp)$/.test(u || "") ? u : "";
// foto o logo; sin imagen, la inicial sobre dorado
function avatar(b, cls = "") {
  const src = mediaUrl(b.avatar), initial = esc([...(b.name || "?").replace(/^@/, "")][0]?.toUpperCase() || "?");
  return `<span class="avatar ${cls} ${b.kind === "company" ? "co" : ""}">${src ? `<img src="${src}" alt="" loading="lazy" decoding="async" />` : initial}</span>`;
}

function renderFeed(isNew) {
  const ol = $("#feed");
  if (!S.recent.length) { ol.innerHTML = `<li class="empty">No one yet. Be the first to light up Latam ✦</li>`; return; }
  ol.innerHTML = S.recent.map((b, i) => `<li class="${isNew && i === 0 ? "new" : ""}"><span class="flag">${flag(b.country)}</span><div><b>${esc(b.name)}</b>${b.n ? ` <small class="mono">#${b.n}</small>` : ""}${subtitle(b) ? ` <em class="inline">${esc(subtitle(b))}</em>` : ""}<em>${esc([b.city, cname(b.country)].filter(Boolean).join(", "))} · ${ago(b.ts)}</em>${b.building ? `<em>✦ ${esc(b.building)}</em>` : ""}</div></li>`).join("");
}
function renderBoard() {
  const rows = Object.entries(S.byCountry).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = rows[0]?.[1] || 1;
  $("#board").innerHTML = rows.length ? rows.map(([cc, n]) => `<li title="${n} ${n === 1 ? "member" : "members"} in ${esc(cname(cc))}"><span>${flag(cc)}</span><span class="cn">${esc(cname(cc))}</span><div class="bar"><i style="width:${(n / max) * 100}%"></i></div><b>${n}</b></li>`).join("") : `<li class="empty" style="display:block;color:var(--mute)">No countries lit yet.</li>`;
}
const bogotaDay = ts => new Date(ts).toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
const shortDay = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
// total acumulado por día (rellenando los días sin registros) como línea con área
function renderGrowth() {
  $("#g-total").textContent = S.total.toLocaleString("en");
  const svg = $("#g-chart");
  if (!S.growth.length) { svg.innerHTML = ""; $("#g-from").textContent = $("#g-to").textContent = $("#g-recent").textContent = ""; return; }
  const per = new Map(S.growth), today = bogotaDay(Date.now());
  const days = [];
  for (let t = Date.parse(S.growth[0][0] + "T12:00:00Z"); ; t += 86400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    days.push(d);
    if (d >= today || days.length > 3660) break;
  }
  let acc = 0;
  const series = days.map(d => (acc += per.get(d) || 0));
  const top = Math.max(1, series[series.length - 1]), W = 300, H = 90;
  const xy = series.map((v, i) => [series.length === 1 ? W : (i / (series.length - 1)) * W, H - 4 - (v / top) * (H - 12)]);
  if (xy.length === 1) xy.unshift([0, H - 4]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const [ex, ey] = xy[xy.length - 1];
  svg.innerHTML = `<defs><linearGradient id="gfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9c063" stop-opacity=".35"/><stop offset="1" stop-color="#e9c063" stop-opacity="0"/></linearGradient></defs>
    <path d="${line}L${W},${H}L0,${H}Z" fill="url(#gfill)"/>
    <path d="${line}" fill="none" stroke="#f3d58c" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <circle cx="${ex}" cy="${ey}" r="3.5" fill="#fff4dc" vector-effect="non-scaling-stroke"/>`;
  const day = per.get(today) || 0, week = days.slice(-7).reduce((s, d) => s + (per.get(d) || 0), 0);
  $("#g-recent").textContent = day ? `· +${day} today` : week ? `· +${week} this week` : "";
  $("#g-from").textContent = shortDay(days[0]);
  $("#g-to").textContent = "Today";
  renderGrowthBig();
}
// gráfico grande: total acumulado (línea) + nuevos por día (barras), con tooltip
let growthDays = [];
function renderGrowthBig() {
  const svg = $("#gb-chart");
  const per = new Map(S.growth), today = bogotaDay(Date.now());
  const days = [];
  if (S.growth.length) for (let t = Date.parse(S.growth[0][0] + "T12:00:00Z"); ; t += 86400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    days.push(d);
    if (d >= today || days.length > 3660) break;
  }
  let acc = 0;
  growthDays = days.map(d => { const n = per.get(d) || 0; acc += n; return { d, n, total: acc }; });
  const week = days.slice(-7).reduce((s, d) => s + (per.get(d) || 0), 0);
  countUp($("#gs-total"), S.total); countUp($("#gs-week"), week);
  countUp($("#gs-countries"), Object.values(S.byCountry).filter(n => n > 0).length);
  countUp($("#gs-people"), S.kinds.person || 0); countUp($("#gs-companies"), S.kinds.company || 0);
  if (!growthDays.length) { svg.innerHTML = ""; $("#gb-x").innerHTML = $("#gb-y").innerHTML = ""; return; }
  const W = 1000, H = 300, P = 34, n = growthDays.length;
  const top = Math.max(1, acc), maxDay = Math.max(1, ...growthDays.map(g => g.n));
  const x = i => P + (n === 1 ? (W - P) / 2 : (i / (n - 1)) * (W - P * 1.4));
  const y = v => H - 18 - (v / top) * (H - 40);
  const bw = Math.max(4, Math.min(40, (W - P) / n * 0.55));
  // las etiquetas del eje van en HTML para que no se deformen con el SVG estirado
  const marks = [0, 0.5, 1].map(f => { const v = Math.round(top * f); return { v, yy: y(v) }; });
  const grid = marks.map(({ yy }) => `<line x1="${P}" x2="${W}" y1="${yy}" y2="${yy}" stroke="#262320" stroke-dasharray="3 5" vector-effect="non-scaling-stroke"/>`).join("");
  $("#gb-y").innerHTML = marks.map(({ v, yy }) => `<span style="top:${(yy / H) * 100}%">${v.toLocaleString("en")}</span>`).join("");
  const bars = growthDays.map((g, i) => { const h = (g.n / maxDay) * (H - 40) * 0.45;
    return g.n ? `<rect x="${x(i) - bw / 2}" y="${H - 18 - h}" width="${bw}" height="${h}" rx="2" fill="rgba(233,192,99,.4)"/>` : ""; }).join("");
  const pts = growthDays.map((g, i) => [x(i), y(g.total)]);
  const line = pts.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)},${b.toFixed(1)}`).join("");
  const [ex, ey] = pts[pts.length - 1];
  svg.innerHTML = `<defs><linearGradient id="gbfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9c063" stop-opacity=".3"/><stop offset="1" stop-color="#e9c063" stop-opacity="0"/></linearGradient></defs>
    ${grid}${bars}
    <path d="${line}L${ex},${H - 18}L${pts[0][0]},${H - 18}Z" fill="url(#gbfill)"/>
    <path d="${line}" fill="none" stroke="#f3d58c" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <circle cx="${ex}" cy="${ey}" r="5" fill="#fff4dc"/>
    <line id="gb-cursor" x1="0" x2="0" y1="10" y2="${H - 18}" stroke="#f3d58c" stroke-opacity=".5" visibility="hidden"/>`;
  const ticks = n <= 8 ? growthDays : [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1].map(i => growthDays[i]);
  $("#gb-x").innerHTML = ticks.map(g => `<span>${g.d === today ? "Today" : shortDay(g.d)}</span>`).join("");
}
$("#gb-chart").addEventListener("pointermove", e => {
  if (!growthDays.length) return;
  const r = e.currentTarget.getBoundingClientRect(), n = growthDays.length;
  const W = 1000, P = 34, fx = ((e.clientX - r.left) / r.width) * W;
  const i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((fx - P) / (W - P * 1.4)) * (n - 1))));
  const g = growthDays[i], px = (n === 1 ? (W - P) / 2 : P + (i / (n - 1)) * (W - P * 1.4));
  const cur = $("#gb-cursor"); cur.setAttribute("x1", px); cur.setAttribute("x2", px); cur.setAttribute("visibility", "visible");
  const tip = $("#gb-tip");
  tip.innerHTML = `${shortDay(g.d)} · <b>${g.total.toLocaleString("en")}</b> members${g.n ? ` · +${g.n} that day` : ""}`;
  tip.style.left = Math.max(80, Math.min(r.width - 80, (px / W) * r.width)) + "px"; tip.hidden = false;
});
$("#gb-chart").addEventListener("pointerleave", () => { $("#gb-tip").hidden = true; $("#gb-cursor")?.setAttribute("visibility", "hidden"); });
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
const dir = { entries: [], q: "", kind: "", country: "", count: 0, seq: 0, loading: false };
const matchesFilter = b => (!dir.kind || b.kind === dir.kind) && (!dir.country || countriesOf(b).includes(dir.country)) &&
  (!dir.q || [b.name, b.company, b.building, b.city].join(" ").toLowerCase().includes(dir.q.toLowerCase()));

function renderChips() {
  const codes = S.countries.filter(c => !c.deco).map(c => c.code).sort((a, b) => (S.byCountry[b] || 0) - (S.byCountry[a] || 0) || cname(a).localeCompare(cname(b)));
  $("#country-chips").innerHTML = [`<li data-cc="" class="${dir.country ? "" : "on"}">All countries</li>`]
    .concat(codes.map(cc => { const n = S.byCountry[cc] || 0; return `<li data-cc="${cc}" class="${n ? "lit" : ""} ${dir.country === cc ? "on" : ""}">${flag(cc)} ${esc(cname(cc))}${n ? ` <small>${n}</small>` : ""}</li>`; })).join("");
}
function renderDir() {
  const ul = $("#dir");
  const where = dir.country ? ` in ${flag(dir.country)} ${cname(dir.country)}` : "";
  const what = (dir.count === 1 ? { company: "company", person: "person", "": "member" } : { company: "companies", person: "people", "": "members" })[dir.kind];
  $("#dir-count").textContent = dir.count ? `${dir.count.toLocaleString("en")} ${what}${where}${dir.q ? ` matching “${dir.q}”` : ""} · click a card to see it on the map` : "";
  $("#dir-more").hidden = dir.entries.length >= dir.count;
  $("#dir-more").textContent = `Show more (${(dir.count - dir.entries.length).toLocaleString("en")} more)`;
  if (!dir.entries.length) {
    ul.innerHTML = `<li class="empty">${dir.q || dir.kind || dir.country ? "No matches yet." : "The directory is waiting for its first members."} <a href="#join">Join the directory</a></li>`;
    return;
  }
  ul.innerHTML = dir.entries.map(b => {
    const site = safeUrl(b.website);
    return `<li class="card" data-id="${esc(b.id)}" data-cc="${esc(b.country)}" tabindex="0" title="See ${esc(b.name)} on the map">
      <div class="card-top">${avatar(b)}<span class="flag">${flag(b.country)}</span><span class="badge ${b.kind}">${b.kind === "company" ? "Company" : "Person"}</span>${b.hiring ? `<button class="badge hiring" type="button" data-hiring="${esc(b.name)}">Hiring · ${b.hiring}</button>` : ""}<small class="mono">#${b.n}</small></div>
      <b>${esc(b.name)}</b>${b.kind === "person" && b.company ? `<span class="co">${esc(b.company)}</span>` : ""}
      ${b.building ? `<p>${esc(b.building)}</p>` : ""}
      ${b.also?.length ? `<span class="also-flags">Also in ${b.also.map(flag).join(" ")}</span>` : ""}
      <div class="card-foot"><span>${esc([b.city, cname(b.country)].filter(Boolean).join(", "))}</span>
        <span class="links">${site ? `<a href="${esc(site)}" target="_blank" rel="noopener nofollow">${esc(host(site))} ↗</a>` : ""}${b.handle ? `<a href="https://x.com/${encodeURIComponent(b.handle)}" target="_blank" rel="noopener nofollow">𝕏</a>` : ""}</span></div>
    </li>`;
  }).join("");
}
let dirTimer;
// primera página o siguiente (append); seq descarta respuestas viejas si cambian los filtros
async function loadDir(more = false) {
  if (more && (dir.loading || dir.entries.length >= dir.count)) return;
  const seq = more ? dir.seq : ++dir.seq;
  dir.loading = true;
  const qs = new URLSearchParams({ q: dir.q, kind: dir.kind, country: dir.country, offset: more ? dir.entries.length : 0 });
  let j = { entries: [], count: 0 };
  try { j = await fetch("/api/directory?" + qs).then(r => r.json()); } catch {}
  dir.loading = false;
  if (seq !== dir.seq) return;
  const seen = new Set(more ? dir.entries.map(e => e.id) : []);
  dir.entries = more ? dir.entries.concat((j.entries || []).filter(e => !seen.has(e.id))) : j.entries || [];
  dir.count = j.count ?? dir.entries.length;
  renderDir();
}
$("#dir-more").addEventListener("click", () => loadDir(true));
// tocar una tarjeta lleva al mapa con esa persona o empresa resaltada
function showOnMap(id, cc) {
  $(".hero").scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  openCountry(cc, id);
  const p = S.points.find(q => q.id === id && q.country === cc);
  if (p) setTimeout(() => { flare(p.x, p.y, `${flag(cc)} ${p.name}`, false); hoverId = id; }, 500);
}
$("#dir").addEventListener("keydown", e => { const li = e.target.closest?.(".card"); if (li && e.key === "Enter") showOnMap(li.dataset.id, li.dataset.cc); });
function filterCountry(cc) {
  dir.country = cc; renderChips(); loadDir();
  if (cc) document.getElementById("directory").scrollIntoView({ behavior: "smooth" });
}
$("#q").addEventListener("input", e => { dir.q = e.target.value.trim(); clearTimeout(dirTimer); dirTimer = setTimeout(loadDir, 200); });
document.querySelectorAll('input[name="fkind"]').forEach(r => r.addEventListener("change", e => { dir.kind = e.target.value; loadDir(); }));
$("#dir").addEventListener("click", e => {
  const name = e.target.closest("[data-hiring]")?.dataset.hiring;
  const card = e.target.closest(".card");
  if (!name && card && !e.target.closest("a")) return showOnMap(card.dataset.id, card.dataset.cc);
  if (!name) return;
  jobs.q = name; $("#jq").value = name; loadJobs();
  document.getElementById("jobs").scrollIntoView({ behavior: "smooth" });
});
$("#country-chips").addEventListener("click", e => {
  const li = e.target.closest("li"); if (!li) return;
  const cc = li.dataset.cc;
  dir.country = cc; renderChips(); loadDir();
  const c = S.byCode[cc];
  if (c) flash = { c: c.index, t: performance.now() / 1000 };
});

// ---------- formulario ----------
const form = $("#form");
// países adicionales (nómadas) y etiquetas persona/empresa, compartidos por el registro y la edición del perfil
function buildAlso(f = form) {
  const grid = f.querySelector(".also-grid");
  grid.innerHTML = S.countries.filter(c => !c.deco).sort((a, b) => a.en.localeCompare(b.en))
    .map(c => `<label><input type="checkbox" value="${c.code}" /> ${flag(c.code)} ${esc(c.en)}</label>`).join("");
  grid.addEventListener("change", () => syncAlso(f));
  f.country.addEventListener("change", () => syncAlso(f));
  syncAlso(f);
}
function syncAlso(f = form) {
  const boxes = [...f.querySelectorAll(".also-grid input")];
  const full = boxes.filter(b => b.checked).length >= 4;
  for (const b of boxes) {
    if (b.value === f.country.value) b.checked = false;
    b.disabled = b.value === f.country.value || (full && !b.checked);
    b.parentElement.classList.toggle("off", b.disabled);
  }
}
const alsoOf = f => [...f.querySelectorAll(".also-grid input:checked")].map(b => b.value);
function syncKind(f = form) {
  const company = f.kind.value === "company";
  f.querySelector("#name-label, .name-label").textContent = company ? "Company name" : "Your name or username";
  f.name.placeholder = company ? "Acme AI" : "Ana Pérez or @ana";
  f.name.autocomplete = company ? "organization" : "nickname";
  f.querySelector("#building-label, .building-label").textContent = company ? "What does the company build?" : "What are you building?";
  f.querySelector(".person-only").hidden = company;
}
form.querySelectorAll('input[name="kind"]').forEach(r => r.addEventListener("change", () => syncKind()));

form.addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("#form-msg"), btn = $("#submit");
  const data = Object.fromEntries(new FormData(form));
  data.also = alsoOf(form);
  msg.className = "form-msg"; msg.textContent = "";
  if (!data.name.trim() || !data.email.includes("@") || !data.country) { msg.className = "form-msg err"; msg.textContent = "Please add a name, email and country."; return; }
  btn.disabled = true; btn.textContent = "Joining…";
  try {
    const r = await fetch("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(guarded(data, "join")) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not register.");
    showDone(j.builder, j.existing);
    if (j.existing) { if (j.canEdit) toast("Already in the directory. Use Edit profile to change it."); return; }
    form.reset(); syncKind(); syncAlso(); $("#also").open = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    // si el socket no llegó, se pinta localmente
    setTimeout(() => onJoin(j.builder), 700);
    toast(`✦ ${j.builder.name} is now on the Latam/acc map`);
  } catch (err) {
    msg.className = "form-msg err"; msg.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = "Join the directory"; resetGuard("join");
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

// ---------- empleos ----------
const jobs = { list: [], q: "", country: "", workplace: "", type: "" };
const WORK = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" };
const TYPES = { "full-time": "Full-time", "part-time": "Part-time", contract: "Contract", internship: "Internship" };
const applyUrl = u => /^(https?:\/\/|mailto:)/i.test(u || "") ? u : "";
const where = j => [j.city, j.country ? `${flag(j.country)} ${cname(j.country)}` : "Anywhere in Latam"].filter(Boolean).join(", ");
function jobCard(j, mine = false) {
  const apply = applyUrl(j.apply);
  return `<li class="job">
    <div class="job-top">${avatar(j.poster)}<div><b>${esc(j.title)}</b><span>${esc(j.company || j.poster.name)}${j.company && j.company !== j.poster.name ? ` · posted by ${esc(j.poster.name)}` : ""}</span></div></div>
    <div class="job-tags"><span class="badge">${WORK[j.workplace] || ""}</span><span class="badge">${TYPES[j.type] || ""}</span><span class="job-where">${esc(where(j))}</span>${j.salary ? `<span class="job-where">· ${esc(j.salary)}</span>` : ""}</div>
    ${j.description ? `<p>${esc(j.description)}</p>` : ""}
    <div class="card-foot"><span>${ago(j.ts)}</span>${mine
      ? `<button class="btn small" type="button" data-close-job="${esc(j.id)}">Close job</button>`
      : apply ? `<a class="btn small primary" href="${esc(apply)}" target="_blank" rel="noopener nofollow">Apply ↗</a>` : ""}</div>
  </li>`;
}
async function loadJobs() {
  const qs = new URLSearchParams({ q: jobs.q, country: jobs.country, workplace: jobs.workplace, type: jobs.type });
  try { jobs.list = (await fetch("/api/jobs?" + qs).then(r => r.json())).jobs || []; } catch { jobs.list = []; }
  const filtered = jobs.q || jobs.country || jobs.workplace || jobs.type;
  $("#jobs-list").innerHTML = jobs.list.length ? jobs.list.map(j => jobCard(j)).join("")
    : filtered ? `<li class="empty">No open roles match these filters. <button class="linkish" type="button" data-me="jobs">Post one →</button></li>`
    : `<li class="jobs-empty"><b>Be the first company hiring on Latam/acc.</b>
        <ul><li>✦ Reach ${S.total.toLocaleString("en")} AI builders across ${Object.values(S.byCountry).filter(n => n > 0).length} countries</li><li>✦ Free for members, live in seconds</li><li>✦ Remote, hybrid or on-site, with your own apply link</li></ul>
        <button class="btn primary" type="button" data-me="jobs">Post a job</button></li>`;
}
// ---------- bounties ----------
const bounties = { list: [], q: "", category: "" };
const CATS = { intro: "Sales intro", product: "Product", content: "Content", other: "Other" };
function due(ts) {
  const d = Math.ceil((ts - Date.now()) / 86400_000);
  return d <= 1 ? "Ends today" : d <= 7 ? `Ends in ${d} days` : `Ends ${new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Bogota" })}`;
}
// escrow: recompensa depositada con MoonPay; LATAMACC la custodia y le paga al ganador
const bountyPay = { enabled: false, feeBps: 1000, minFee: 5, minReward: 25, maxReward: 25000 };
const feeOf = usd => Math.max(bountyPay.minFee, Math.ceil(usd * bountyPay.feeBps / 10000));
const usd = n => "$" + Number(n).toLocaleString("en-US");
const ESCROW_STATUS = { awarded: "Winner picked · payout pending", refund_requested: "Refund requested", paid_out: "Paid to winner ✦", refunded: "Refunded" };
function fundingActions(x) {
  const f = x.funding;
  if (x.funded) return `<button class="btn small" type="button" data-award-bounty="${esc(x.id)}">Pick winner</button>`;
  if (!x.rewardUsd || !bountyPay.enabled) return "";
  if (f?.status === "awaiting_payment" && checkoutUrl(f.checkoutUrl))
    return `<a class="btn small primary" href="${esc(checkoutUrl(f.checkoutUrl))}" rel="noopener">Complete deposit ↗</a>
      <button class="btn small" type="button" data-check-fund="${esc(x.id)}">Check payment</button>`;
  return `<button class="btn small primary" type="button" data-fund-bounty="${esc(x.id)}">Deposit ${usd(x.rewardUsd + feeOf(x.rewardUsd))}</button>`;
}
function bountyCard(x, mine = false) {
  const submit = applyUrl(x.submit), soon = x.deadline - Date.now() < 3 * 86400_000;
  return `<li class="job bounty${x.funded ? " funded" : ""}">
    <div class="job-tags"><span class="badge cat-${esc(x.category)}">${CATS[x.category] || ""}</span>${x.funded ? `<span class="badge escrow" title="The reward is deposited with Latam/acc and paid to the winner">✦ Funded · in escrow</span>` : ""}<span class="bounty-due ${soon ? "urgent" : ""}">${due(x.deadline)}</span></div>
    <span class="bounty-reward">${esc(x.reward)}</span>
    <div class="job-top">${avatar(x.poster)}<div><b>${esc(x.title)}</b><span>posted by ${esc(x.poster.name)} · ${ago(x.ts)}</span></div></div>
    ${x.description ? `<p>${esc(x.description)}</p>` : ""}
    ${mine && x.rewardUsd && !x.funded && bountyPay.enabled ? `<p class="fine">Deposit ${usd(x.rewardUsd)} + ${usd(feeOf(x.rewardUsd))} Latam/acc fee with MoonPay (USDC on Solana). We hold it and pay the winner in USDC on Solana.</p>` : ""}
    <div class="card-foot"><span></span>${mine
      ? `<span class="card-actions">${fundingActions(x)}<button class="btn small" type="button" data-close-bounty="${esc(x.id)}">Close bounty</button></span>`
      : submit ? `<a class="btn small primary" href="${esc(submit)}" target="_blank" rel="noopener nofollow">Submit ↗</a>` : ""}</div>
  </li>`;
}
async function loadBounties() {
  const qs = new URLSearchParams({ q: bounties.q, category: bounties.category });
  try { bounties.list = (await fetch("/api/bounties?" + qs).then(r => r.json())).bounties || []; } catch { bounties.list = []; }
  const filtered = bounties.q || bounties.category;
  $("#bounties-list").innerHTML = bounties.list.length ? bounties.list.map(x => bountyCard(x)).join("")
    : filtered ? `<li class="empty">No open bounties match. <button class="linkish" type="button" data-me="bounties">Post one →</button></li>`
    : `<li class="jobs-empty"><b>Post the first bounty on Latam/acc.</b>
        <ul><li>✦ Intros to sales leads, product work or content, from ${S.total.toLocaleString("en")} builders across ${Object.values(S.byCountry).filter(n => n > 0).length} countries</li><li>✦ You set the reward and the deadline, and pay whoever delivers</li><li>✦ Free for members, live in seconds</li></ul>
        <button class="btn primary" type="button" data-me="bounties">Post a bounty</button></li>`;
}
let bountiesTimer;
$("#bq").addEventListener("input", e => { bounties.q = e.target.value.trim(); clearTimeout(bountiesTimer); bountiesTimer = setTimeout(loadBounties, 200); });
document.querySelectorAll('input[name="bcat"]').forEach(r => r.addEventListener("change", e => { bounties.category = e.target.value; loadBounties(); }));

let jobsTimer;
$("#jq").addEventListener("input", e => { jobs.q = e.target.value.trim(); clearTimeout(jobsTimer); jobsTimer = setTimeout(loadJobs, 200); });
$("#jcountry").addEventListener("change", e => { jobs.country = e.target.value; loadJobs(); });
$("#jtype").addEventListener("change", e => { jobs.type = e.target.value; loadJobs(); });
document.querySelectorAll('input[name="jwork"]').forEach(r => r.addEventListener("change", e => { jobs.workplace = e.target.value; loadJobs(); }));

// ---------- miembros: enlace por correo, editar perfil, foto/logo y empleos ----------
const dlg = $("#me"), pform = $("#pform"), jform = $("#jform"), signin = $("#signin");
const member = { session: "", me: null, editing: true, uploads: true };
try { member.session = localStorage.getItem("latamacc-session") || ""; } catch {}
function saveSession(v) { member.session = v; try { v ? localStorage.setItem("latamacc-session", v) : localStorage.removeItem("latamacc-session"); } catch {} }
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { authorization: `Bearer ${member.session}`, ...(opts.json ? { "content-type": "application/json" } : {}), ...opts.headers },
    body: opts.json ? JSON.stringify(opts.json) : opts.body });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { saveSession(""); member.me = null; showMe(); }
  if (!r.ok) throw new Error(j.error || "Something went wrong. Please try again.");
  if (j.me) { member.me = j.me; renderMe(); }
  return j;
}
function setTab(tab) {
  $("#me-profile").hidden = tab !== "profile"; $("#me-jobs").hidden = tab !== "jobs"; $("#me-bounties").hidden = tab !== "bounties";
  dlg.querySelector(`input[name="metab"][value="${tab}"]`).checked = true;
}
function showMe(tab) {
  const signed = !!(member.session && member.me);
  $("#me-signin").hidden = signed; $("#me-main").hidden = !signed;
  if (signed && tab) setTab(tab);
}
async function openMe(tab = "profile") {
  if (!dlg.open) dlg.showModal();
  if (member.session && !member.me) { try { await api("/api/me"); } catch {} }
  showMe(tab);
  if (!member.me) {
    const m = signin.querySelector(".form-msg");
    m.className = "form-msg"; m.textContent = tab === "jobs" ? "Jobs are posted by directory members. Sign in to post one."
      : tab === "bounties" ? "Bounties are posted by directory members. Sign in to post one." : "";
    if (!member.editing) { m.className = "form-msg err"; m.textContent = "Email sign-in opens very soon. Please check back later."; }
  }
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-me]");
  if (b) { e.preventDefault(); openMe(b.dataset.me); }
  if (e.target.closest("[data-close]")) dlg.close();
});
$("#me-close").addEventListener("click", () => dlg.close());
dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
dlg.querySelectorAll('input[name="metab"]').forEach(r => r.addEventListener("change", e => setTab(e.target.value)));
function renderMe() {
  const m = member.me;
  if (!m) return;
  $("#me-avatar").outerHTML = avatar(m, "big").replace('class="avatar', 'id="me-avatar" class="avatar');
  $("#photo-preview").outerHTML = avatar(m).replace('class="avatar', 'id="photo-preview" class="avatar');
  $("#me-name").textContent = m.name;
  $("#me-n").textContent = `${m.kind === "company" ? "Company" : "Member"} #${m.n}`;
  $("#me-email").textContent = `Signed in as ${m.email} (private)`;
  $("#photo-label").textContent = m.kind === "company" ? "Logo" : "Photo";
  $("#photo-remove").hidden = !m.avatar;
  $("#photo-file").disabled = !member.uploads;
  $("#me-profile .photo").hidden = !member.uploads && !m.avatar;
  pform.kind.value = m.kind;
  for (const k of ["name", "company", "country", "city", "building", "website", "handle"]) pform[k].value = m[k] || "";
  for (const b of pform.querySelectorAll(".also-grid input")) b.checked = m.also.includes(b.value);
  pform.querySelector(".also").open = m.also.length > 0;
  syncKind(pform); syncAlso(pform);
  $("#my-bounties").innerHTML = m.bounties?.length ? `<li class="form-title">Your open bounties</li>` + m.bounties.map(x => bountyCard(x, true)).join("") : "";
  $("#my-escrow").innerHTML = m.escrow?.length ? `<li class="form-title">Escrow payouts</li>` + m.escrow.map(f => `<li class="job escrow-row">
    <div><b>${esc(f.title)}</b><span>${usd(f.reward)} · ${ESCROW_STATUS[f.status] || esc(f.status)}${f.winner ? ` · ${esc(f.winner)}` : ""}</span></div>
    ${f.signature ? `<a class="btn small" href="https://solscan.io/tx/${encodeURIComponent(f.signature)}" target="_blank" rel="noopener">Transaction ↗</a>` : ""}</li>`).join("") : "";
  $("#my-jobs").innerHTML = m.jobs.length ? `<li class="form-title">Your open jobs</li>` + m.jobs.map(j => jobCard(j, true)).join("") : "";
}
function formMsg(f, text, ok = false) { const m = f.querySelector(".form-msg"); m.className = `form-msg ${ok ? "ok" : "err"}`; m.textContent = text; }
signin.addEventListener("submit", async e => {
  e.preventDefault();
  const btn = signin.querySelector("button[type=submit]"), data = Object.fromEntries(new FormData(signin));
  if (!data.email.includes("@")) return formMsg(signin, "Add the email you joined with.");
  btn.disabled = true;
  try {
    const r = await fetch("/api/signin/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(guarded(data, "signin")) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not send the link.");
    formMsg(signin, "Check your inbox ✦ If that email is in the directory, a sign-in link is on its way. It works once, for 24 hours.", true);
  } catch (err) { formMsg(signin, err.message); }
  finally { btn.disabled = false; resetGuard("signin"); }
});
pform.querySelectorAll('input[name="kind"]').forEach(r => r.addEventListener("change", () => syncKind(pform)));
pform.addEventListener("submit", async e => {
  e.preventDefault();
  const btn = pform.querySelector("button[type=submit]"), data = Object.fromEntries(new FormData(pform));
  data.also = alsoOf(pform);
  btn.disabled = true;
  try { await api("/api/me", { method: "POST", json: data }); formMsg(pform, "Saved ✦ Your profile is updated for everyone.", true); }
  catch (err) { formMsg(pform, err.message); }
  finally { btn.disabled = false; }
});
// la imagen se reduce en el navegador (máx. 512 px) antes de subirla
async function shrink(file) {
  const img = await createImageBitmap(file);
  const k = Math.min(1, 512 / Math.max(img.width, img.height));
  const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(b => res(b), "image/webp", 0.88));
}
$("#photo-file").addEventListener("change", async e => {
  const file = e.target.files[0]; e.target.value = "";
  if (!file) return;
  const m = $("#me-profile .form-msg");
  m.className = "form-msg"; m.textContent = "Uploading…";
  try {
    let blob = file;
    try { blob = (await shrink(file)) || file; } catch {}
    await api("/api/me/avatar", { method: "POST", body: blob, headers: { "content-type": blob.type || "application/octet-stream" } });
    formMsg(pform, `${member.me.kind === "company" ? "Logo" : "Photo"} updated ✦`, true);
  } catch (err) { formMsg(pform, err.message); }
});
$("#photo-remove").addEventListener("click", async () => {
  try { await api("/api/me/avatar", { method: "DELETE" }); formMsg(pform, "Removed.", true); } catch (err) { formMsg(pform, err.message); }
});
jform.workplace.addEventListener("change", () => { jform.country.options[0].text = jform.workplace.value === "remote" ? "Anywhere in Latam (remote)" : "Select a country"; });
jform.addEventListener("submit", async e => {
  e.preventDefault();
  const btn = jform.querySelector("button[type=submit]"), data = Object.fromEntries(new FormData(jform));
  btn.disabled = true;
  try {
    await api("/api/me/jobs", { method: "POST", json: data });
    jform.reset(); formMsg(jform, "Published ✦ Your job is live in the Jobs section.", true); loadJobs();
  } catch (err) { formMsg(jform, err.message); }
  finally { btn.disabled = false; }
});
const bform = $("#bform");
bform.addEventListener("submit", async e => {
  e.preventDefault();
  const btn = bform.querySelector("button[type=submit]"), data = Object.fromEntries(new FormData(bform));
  btn.disabled = true;
  try {
    await api("/api/me/bounties", { method: "POST", json: data });
    bform.reset(); formMsg(bform, "Published ✦ Your bounty is live in the Bounties section.", true); loadBounties();
  } catch (err) { formMsg(bform, err.message); }
  finally { btn.disabled = false; }
});
$("#my-bounties").addEventListener("click", async e => {
  const fund = e.target.closest("[data-fund-bounty]")?.dataset.fundBounty, check = e.target.closest("[data-check-fund]")?.dataset.checkFund;
  const award = e.target.closest("[data-award-bounty]")?.dataset.awardBounty;
  if (fund) {
    e.target.disabled = true;
    try {
      const j = await api(`/api/me/bounties/${fund}/fund`, { method: "POST" });
      const url = checkoutUrl(j.funding?.checkoutUrl);
      if (!url) throw new Error("Checkout is unavailable. Please try again.");
      location.assign(url);
    } catch (err) { toast(err.message); e.target.disabled = false; }
    return;
  }
  if (check) return checkFunding(check);
  if (award) {
    const winner = prompt("Who delivered? Winner's name");
    if (!winner) return;
    const wallet = prompt("Winner's Solana wallet address (Latam/acc pays the reward there in USDC)");
    if (!wallet) return;
    try { await api(`/api/me/bounties/${award}/award`, { method: "POST", json: { winner, wallet: wallet.trim() } }); toast("Winner saved ✦ Latam/acc will send the payout."); loadBounties(); }
    catch (err) { toast(err.message); }
    return;
  }
  const id = e.target.closest("[data-close-bounty]")?.dataset.closeBounty;
  const funded = member.me?.bounties?.find(x => x.id === id)?.funded;
  if (!id || !confirm(funded ? "Close this bounty without a winner? We'll refund the reward you deposited (the fee is not refunded)." : "Close this bounty? It will disappear from the Bounties section.")) return;
  try { await api(`/api/me/bounties/${id}/close`, { method: "POST" }); loadBounties(); } catch (err) { toast(err.message); }
});
async function checkFunding(id, quiet = false) {
  try {
    const j = await api(`/api/me/bounties/${id}/fund`);
    const s = j.funding?.status;
    toast(s === "paid" ? "Deposit confirmed ✦ Your bounty now shows as funded." : s === "awaiting_payment" ? "Payment not confirmed yet. Complete it in MoonPay and check again."
      : s === "expired" ? "That checkout expired. Start a new deposit." : s === "payment_failed" ? "The payment didn't go through. Try the deposit again." : "Deposit updated.");
    loadBounties();
  } catch (err) { if (!quiet) toast(err.message); }
}
// vuelta desde MoonPay: ?bounty=<id>
function bountyReturn() {
  const id = new URLSearchParams(location.search).get("bounty");
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return;
  history.replaceState(null, "", location.pathname + location.hash);
  if (member.session) { openMe("bounties"); checkFunding(id); }
}
$("#my-jobs").addEventListener("click", async e => {
  const id = e.target.closest("[data-close-job]")?.dataset.closeJob;
  if (!id || !confirm("Close this job? It will disappear from the Jobs section.")) return;
  try { await api(`/api/me/jobs/${id}/close`, { method: "POST" }); loadJobs(); } catch (err) { toast(err.message); }
});
$("#me-signout").addEventListener("click", async () => {
  try { await api("/api/me/signout", { method: "POST" }); } catch {}
  saveSession(""); member.me = null; showMe(); toast("Signed out.");
});
$("#me-delete").addEventListener("click", async () => {
  if (!confirm("Remove your profile from the directory? Your light, profile, jobs and bounties will be deleted. This can't be undone.")) return;
  try { await api("/api/me", { method: "DELETE" }); saveSession(""); member.me = null; dlg.close(); toast("Your profile was removed."); }
  catch (err) { toast(err.message); }
});
// enlace del correo: latamacc.si/#signin=TOKEN (el fragmento nunca llega al servidor ni a los logs)
async function consumeSignin() {
  const m = /^#signin=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  if (!dlg.open) dlg.showModal();
  try {
    const r = await fetch("/api/signin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: m[1] }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not sign in.");
    saveSession(j.session); member.me = j.me; renderMe(); showMe("profile");
    toast("Signed in ✦ Edit your profile below.");
  } catch (err) { showMe(); formMsg(signin, err.message); }
}

// ---------- anti-bots ----------
// ft: token firmado del servidor al cargar; Turnstile solo si el servidor tiene clave.
const guard = { ft: "", sitekey: null, widgets: {} };
function loadTurnstile() {
  if (!guard.sitekey) return;
  window.onTurnstileLoad = () => document.querySelectorAll(".ts").forEach(el => {
    guard.widgets[el.dataset.form] = turnstile.render(el, { sitekey: guard.sitekey, theme: "dark" });
  });
  const sc = document.createElement("script");
  sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit";
  sc.async = true; document.head.append(sc);
}
function guarded(data, form) {
  data.ft = guard.ft;
  const w = guard.widgets[form];
  if (w !== undefined && window.turnstile) data.turnstile = turnstile.getResponse(w) || "";
  return data;
}
function resetGuard(form) { const w = guard.widgets[form]; if (w !== undefined && window.turnstile) turnstile.reset(w); }

// ---------- merch y checkout ----------
const po = $("#preorder");
const merchPayments = { tee: false, "tee-white": false, cap: false, "cap-navy": false };
let pendingPayment = null, checkingPayment = false;
try { pendingPayment = JSON.parse(sessionStorage.getItem("latamacc-checkout") || "null"); } catch {}
const ITEMS = {
  tee: { name: "latam/acc Tee · Black", price: 49, fits: ["M", "W"], sizes: ["S", "M", "L", "XL"] },
  "tee-white": { name: "latam/acc Tee · White", price: 49, fits: ["M", "W"], sizes: ["S", "M", "L", "XL"] },
  cap: { name: "latam/acc Cap · Black", price: 49, sizes: ["ONE"] },
  "cap-navy": { name: "latam/acc Cap · Navy", price: 49, sizes: ["ONE"] },
};
const FITS = { M: "Men", W: "Women" };
// "W-L" → "Women · L"; las tallas sin corte ("ONE") se muestran tal cual.
function sizeLabel(size) {
  const [fit, sz] = String(size).split("-");
  return sz ? `${FITS[fit] || fit} · ${sz}` : size === "ONE" ? "One size" : size;
}
function poButton() {
  const it = ITEMS[po.item.value], q = Math.min(10, Math.max(1, Math.trunc(Number(po.qty.value)) || 1));
  const pays = merchPayments[po.item.value];
  $("#po-action").textContent = pays ? "Order the" : "Pre-order the";
  $("#po-btn").textContent = pays ? `Continue to MoonPay · $${it.price * q}` : it.price ? `Pre-order · $${it.price * q}` : "Pre-order · price by email";
  $("#po-note").textContent = pays
    ? "Pre-order merchandise total in USD. Shipping and delivery are confirmed by email. Your order details are shared with MoonPay for checkout; your delivery address and any payment fees are shown there."
    : "No payment today. We'll email you to confirm price, shipping and delivery.";
}

function checkoutUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && ["moonpay.hel.io", "pay.hel.io", "app.hel.io", "hel.io"].includes(u.hostname) && (!u.port || u.port === "443") && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}
function savePayment(value) {
  pendingPayment = value;
  try {
    if (value) sessionStorage.setItem("latamacc-checkout", JSON.stringify(value));
    else sessionStorage.removeItem("latamacc-checkout");
    return true;
  } catch { return false; }
}
function showPayment(status = pendingPayment?.status || "awaiting_payment") {
  if (!pendingPayment) return;
  const paid = status === "paid", expired = status === "expired", failed = status === "payment_failed";
  const opened = $("#payment-status").hidden;
  $("#payment-status").hidden = false;
  $("#payment-title").textContent = paid ? "Payment confirmed ✦" : expired ? "Checkout expired" : failed ? "Payment could not be completed" : "Your order is awaiting payment";
  const it = ITEMS[pendingPayment.item];
  $("#payment-detail").textContent = `${pendingPayment.qty} × ${it?.name || "Merch"} (${sizeLabel(pendingPayment.size)}) · $${pendingPayment.total} USD. `
    + (paid ? "We'll email you to confirm shipping and delivery." : expired || failed ? "Start another order to get a fresh checkout." : "Complete checkout in MoonPay, then check your payment here. A reservation is confirmed as paid only after payment verification.");
  const url = checkoutUrl(pendingPayment.checkoutUrl);
  $("#payment-resume").hidden = !url || paid || expired || failed;
  if (url) $("#payment-resume").href = url;
  $("#payment-refresh").hidden = paid || expired || failed;
  po.hidden = true;
  if (opened) $("#payment-title").focus();
}
async function checkPayment() {
  if (!pendingPayment?.statusToken || checkingPayment) return;
  checkingPayment = true;
  $("#payment-refresh").disabled = true;
  try {
    const r = await fetch(`/api/merch/status?token=${encodeURIComponent(pendingPayment.statusToken)}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not verify payment. Please try again.");
    if (!["awaiting_payment", "paid", "expired", "payment_failed"].includes(j.status)) throw new Error("Could not verify payment. Please try again.");
    savePayment({ ...pendingPayment, status: j.status, item: j.item, size: j.size, qty: j.qty, total: j.total });
    showPayment(j.status);
  } catch (err) {
    $("#payment-detail").textContent = err.message;
  } finally { checkingPayment = false; $("#payment-refresh").disabled = false; }
}
$("#payment-refresh").addEventListener("click", checkPayment);
$("#payment-new").addEventListener("click", () => {
  if (checkingPayment) return;
  savePayment(null); $("#payment-status").hidden = true; po.hidden = false;
  $("#po-msg").textContent = "";
  po.email.focus();
});
function pickItem(li) {
  const key = li.dataset.item, it = ITEMS[key];
  document.querySelectorAll(".drop").forEach(d => d.classList.toggle("picked", d === li));
  po.item.value = key;
  $("#po-item").textContent = it.name;
  $("#po-price").textContent = it.price ? `$${it.price} USD` : "Price soon";
  $("#po-fits").hidden = !it.fits;
  $("#po-fits").innerHTML = (it.fits || []).map((f, i) => `<label><input type="radio" name="fit" value="${f}" ${i === 0 ? "checked" : ""} /> <span>${FITS[f]}</span></label>`).join("");
  $("#po-sizes").innerHTML = it.sizes.map(sz => `<label><input type="radio" name="size" value="${sz}" ${sz === "M" || it.sizes.length === 1 ? "checked" : ""} /> <span>${sz === "ONE" ? "One size" : sz}</span></label>`).join("");
  poButton();
}
document.querySelectorAll(".drop").forEach(li => {
  li.addEventListener("click", () => pickItem(li));
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
po.qty.addEventListener("input", poButton);
po.addEventListener("submit", async e => {
  e.preventDefault();
  const msg = $("#po-msg"), btn = $("#po-btn");
  const data = Object.fromEntries(new FormData(po));
  if (data.fit) { data.size = `${data.fit}-${data.size}`; delete data.fit; }
  msg.className = "form-msg"; msg.textContent = "";
  if (!data.email.includes("@") || !data.country) { msg.className = "form-msg err"; msg.textContent = "Please add your email and shipping country."; return; }
  btn.disabled = true;
  btn.textContent = merchPayments[data.item] ? "Preparing checkout…" : "Reserving…";
  try {
    const r = await fetch("/api/merch/preorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(guarded(data, "preorder")) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not pre-order.");
    if (j.payment) {
      const url = checkoutUrl(j.payment.checkoutUrl);
      if (!url || !j.payment.statusToken) throw new Error("Checkout is unavailable. Please try again.");
      const saved = savePayment({ statusToken: j.payment.statusToken, checkoutUrl: url, status: "awaiting_payment", item: j.item, size: j.size, qty: j.qty, total: j.total });
      showPayment();
      if (saved) location.assign(url);
      else $("#payment-detail").textContent += " Keep this page open and use Continue to MoonPay in a new tab so you can check your payment here.";
      return;
    }
    const it = ITEMS[data.item];
    msg.className = "form-msg ok";
    msg.textContent = `Pre-ordered ✦ ${data.qty} × ${it.name}${data.size !== "ONE" ? ` (${sizeLabel(data.size)})` : ""}${j.total ? ` · $${j.total} USD` : ""}. We'll email you to confirm payment and shipping.`;
    po.email.value = ""; po.name.value = ""; po.qty.value = 1; poButton();
  } catch (err) {
    msg.className = "form-msg err"; msg.textContent = err.message;
  } finally { btn.disabled = false; poButton(); resetGuard("preorder"); }
});

// ---------- arranque ----------
const io = new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return;
  e.target.classList.add("in");
  io.unobserve(e.target);
}), { threshold: 0.15 });
document.querySelectorAll(".reveal").forEach(el => io.observe(el));
new IntersectionObserver(([e]) => { heroVisible = e.isIntersecting; }).observe($(".hero"));

// barra inferior en móvil: marca la sección visible
const tabs = [...document.querySelectorAll(".tabbar [data-tab]")];
const tabIO = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) tabs.forEach(t => t.classList.toggle("on", t.dataset.tab === e.target.id));
}), { rootMargin: "-45% 0px -50% 0px" });
["top", "join", "directory", "bounties"].forEach(id => tabIO.observe(document.getElementById(id)));
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

  S.total = state.total; S.byCountry = state.byCountry; S.recent = state.recent; S.watching = state.watching || {}; S.growth = state.growth || []; S.kinds = state.kinds || {};
  buildAlso(form); buildAlso(pform);
  for (const sel2 of [pform.country, jform.country, $("#jcountry")])
    S.countries.filter(c => !c.deco).sort((a, b) => a.en.localeCompare(b.en)).forEach(c => sel2.add(new Option(`${flag(c.code)} ${c.en}`, c.code)));
  member.editing = state.editing !== false; member.uploads = state.uploads !== false;
  setOnline(state.online || 1);
  const psel = $("#po-country");
  S.countries.filter(c => !c.deco).sort((a, b) => a.en.localeCompare(b.en)).forEach(c => psel.add(new Option(`${flag(c.code)} ${c.en}`, c.code)));
  if (state.you && S.byCode[state.you]) { if (!sel.value) sel.value = state.you; psel.value = state.you; }
  guard.ft = state.ft || ""; guard.sitekey = state.turnstile; loadTurnstile();
  Object.assign(merchPayments, state.merchPayments || {}); poButton();
  Object.assign(bountyPay, state.bountyPayments || {});
  if (bountyPay.enabled) {
    $(".escrow-field").hidden = false;
    $("#bounties-lead").textContent = "Rewards from members for sales intros, product work and content. Pick one, deliver, and get paid. Bounties marked Funded are held in escrow by Latam/acc and paid to the winner. Posting is free.";
    $("#bounty-terms").textContent = `Bounties are public with your profile name. Pay the winner directly, or add an escrow amount and deposit it with MoonPay: Latam/acc holds it, charges a ${bountyPay.feeBps / 100}% fee (min $${bountyPay.minFee}) and pays the winner in USDC on Solana. If you close it without a winner, we refund the reward (not the fee).`;
  }
  if (merchPayments.tee) {
    $("#merch-lead").textContent = "The first Latam/acc drop, built in public. Two tees and two caps, made for builders. Pre-order with MoonPay.";
  }
  if (pendingPayment?.statusToken) { showPayment(); checkPayment(); }
  // los miembros existentes se encienden en cascada cuando termina el dorado
  const base = START + BURN;
  state.points.slice().reverse().forEach((b, i, arr) => {
    S.seen.add(b.id);
    for (const cc of countriesOf(b)) {
      const pt = placePoint(b, cc);
      if (pt) { pt.born = base + (i / Math.max(1, arr.length)) * Math.min(3, arr.length * 0.15); S.points.push(pt); }
    }
  });
  renderStats(); renderFeed(false); renderBoard(); renderGrowth(); renderChips(); syncKind();
  loadDir(); loadJobs(); loadBounties(); consumeSignin(); bountyReturn();
  addEventListener("hashchange", consumeSignin);
  connect();
  requestAnimationFrame(frame);
})();
