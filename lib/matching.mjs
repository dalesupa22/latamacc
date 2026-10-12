// Agente de networking: cruza lo que cada miembro busca ("seeking") con lo que otros ofrecen ("offer",
// lo que construyen, su empresa) y al revés. Sin servicios externos: palabras clave normalizadas, sinónimos
// en inglés y español, y peso IDF para que términos raros cuenten más que los comunes.

const STOP = new Set(`a an and are as at be by for from has have i in is it its of on or our that the their them they this to us we
with you your my me will can who what want looking look talk meet people company companies startup startups build building
el la los las un una unos unas y o de del en con por para que se su sus nuestro nuestra nosotros es son al lo como más mas
buscamos busco quiero queremos hablar conocer empresa empresas personas gente
head heads work new help based latam latin america region world global`.split(/\s+/));

// grupos de sinónimos → concepto canónico (la etiqueta se muestra al usuario)
const GROUPS = {
  investors: "investor investors invest investing investment investments vc vcs capital funding fund funds raise raising fundraising angel angels seed preseed pre-seed inversion inversionista inversionistas inversores inversor financiacion financiamiento ronda",
  customers: "customer customers client clients sales sell selling leads lead buyers distribution b2b enterprise enterprises clientes cliente ventas venta compradores",
  talent: "hire hiring talent engineer engineers developer developers devs dev recruit recruiting team cofounder cofounders co-founder talento ingenieros desarrolladores contratar equipo cofundador",
  partners: "partner partners partnership partnerships alliance alliances collaborate collaboration aliado aliados alianza alianzas socio socios colaborar",
  ai: "ai ia llm llms ml genai gpt agent agents agentic machine-learning deep-learning inteligencia agentes modelos",
  fintech: "fintech payments payment pagos pago banking bank banks banco bancos crypto web3 blockchain stablecoin stablecoins defi solana",
  health: "health healthcare medical medicine salud medico medica clinica clinicas hospital hospitals biotech",
  education: "education edtech learning school schools university universities educacion universidad universidades colegios cursos courses training",
  marketing: "marketing growth content contenido creators creator influencers brand branding community comunidad social media",
  mentors: "mentor mentors mentorship advice advisor advisors advisory mentoria mentoria asesoria asesor asesores",
  data: "data datos analytics analitica",
  legal: "legal lawyer lawyers abogado abogados compliance regulatory regulacion",
  design: "design designer designers diseno disenador ux ui product producto",
  agro: "agro agtech agriculture agricultura farming",
  energy: "energy climate climatech energia clima solar",
  government: "government gov govtech gobierno public publico",
  media: "media press podcast periodistas journalists prensa",
};
const CANON = new Map();
for (const [k, words] of Object.entries(GROUPS)) for (const w of words.split(/\s+/)) CANON.set(w, k);

const fold = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
// singular aproximado para que "agents"/"agent" o "clientes"/"cliente" coincidan
const stem = w => w.length > 4 && w.endsWith("es") && !w.endsWith("ses") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;

export function terms(text) {
  const out = new Set();
  for (const raw of fold(text).match(/[a-z0-9][a-z0-9+-]*/g) || []) {
    if (STOP.has(raw) || (raw.length < 3 && raw !== "ai" && raw !== "ia" && raw !== "ml" && raw !== "ux" && raw !== "ui")) continue;
    out.add(CANON.get(raw) || CANON.get(stem(raw)) || stem(raw));
  }
  return out;
}
const isConcept = t => t in GROUPS;

// profile: { id, offer, seeking, building, company, name, country, calls }
export function profileTerms(p) {
  return {
    seeks: terms(p.seeking),
    gives: new Set([...terms(p.offer), ...terms(p.building), ...terms(p.company)]),
  };
}

// Devuelve los mejores cruces para `me` dentro de `all` (filas del directorio con offer/seeking).
export function findMatches(me, all, limit = 8) {
  const docs = all.map(p => ({ p, ...profileTerms(p) }));
  const df = new Map();
  for (const d of docs) for (const t of new Set([...d.seeks, ...d.gives])) df.set(t, (df.get(t) || 0) + 1);
  const N = Math.max(docs.length, 1);
  const idf = t => Math.log(1 + N / (1 + (df.get(t) || 0))) * (isConcept(t) ? 1.3 : 1);
  const mine = docs.find(d => d.p.id === me.id) || { p: me, ...profileTerms(me) };
  const out = [];
  for (const d of docs) {
    if (d.p.id === me.id) continue;
    const theyHave = [...mine.seeks].filter(t => d.gives.has(t));   // lo que busco y ellos ofrecen
    const theyWant = [...d.seeks].filter(t => mine.gives.has(t));   // lo que buscan y yo ofrezco
    if (!theyHave.length && !theyWant.length) continue;
    let score = theyHave.reduce((s, t) => s + idf(t), 0) * 1.2 + theyWant.reduce((s, t) => s + idf(t), 0);
    if (theyHave.length && theyWant.length) score *= 1.5; // interés mutuo
    if (d.p.country === me.country) score += 0.4;
    if (d.p.calls) score += 0.3;
    out.push({ id: d.p.id, score, theyHave: label(theyHave), theyWant: label(theyWant) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
const label = list => list.sort((a, b) => isConcept(b) - isConcept(a)).slice(0, 4);
