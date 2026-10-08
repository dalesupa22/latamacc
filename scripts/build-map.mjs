// Genera public/assets/latam.json: países de Latam proyectados a un lienzo fijo.
import { readFileSync, writeFileSync } from "node:fs";
import { feature } from "topojson-client";
import { geoMercator, geoPath, geoCentroid, geoArea } from "d3-geo";

const src = process.argv[2];
const topo = JSON.parse(readFileSync(src, "utf8"));
const world = feature(topo, topo.objects.countries);

// id numérico ISO → [ISO2, nombre ES, nombre EN]
const LATAM = {
  "484": ["MX", "México", "Mexico"], "084": ["BZ", "Belice", "Belize"], "188": ["CR", "Costa Rica", "Costa Rica"],
  "222": ["SV", "El Salvador", "El Salvador"], "320": ["GT", "Guatemala", "Guatemala"], "340": ["HN", "Honduras", "Honduras"],
  "558": ["NI", "Nicaragua", "Nicaragua"], "591": ["PA", "Panamá", "Panama"], "032": ["AR", "Argentina", "Argentina"],
  "068": ["BO", "Bolivia", "Bolivia"], "076": ["BR", "Brasil", "Brazil"], "152": ["CL", "Chile", "Chile"],
  "170": ["CO", "Colombia", "Colombia"], "218": ["EC", "Ecuador", "Ecuador"], "328": ["GY", "Guyana", "Guyana"],
  "600": ["PY", "Paraguay", "Paraguay"], "604": ["PE", "Perú", "Peru"], "740": ["SR", "Surinam", "Suriname"],
  "858": ["UY", "Uruguay", "Uruguay"], "862": ["VE", "Venezuela", "Venezuela"], "192": ["CU", "Cuba", "Cuba"],
  "214": ["DO", "República Dominicana", "Dominican Republic"], "630": ["PR", "Puerto Rico", "Puerto Rico"], "332": ["HT", "Haití", "Haiti"],
};
// Solo decorativos, para que la silueta no quede con huecos.
const EXTRA = { "388": "JM", "780": "TT", "044": "BS" };

const feats = [];
for (const f of world.features) {
  if (LATAM[f.id]) feats.push({ ...f, props: { code: LATAM[f.id][0], es: LATAM[f.id][1], en: LATAM[f.id][2], deco: false } });
  else if (EXTRA[f.id]) feats.push({ ...f, props: { code: EXTRA[f.id], deco: true } });
  else if (f.id === "250") {
    // Guayana Francesa sale dentro de Francia: se extrae su polígono.
    const polys = f.geometry.coordinates.filter(p => p[0][0][0] < -40 && p[0][0][0] > -60);
    feats.push({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: polys }, props: { code: "GF", deco: true } });
  }
}

const W = 1000;
const fc = { type: "FeatureCollection", features: feats.filter(f => !f.props.deco) };
const proj = geoMercator().fitWidth(W, fc);
const H = Math.ceil(geoPath(proj).bounds(fc)[1][1]);

const round = v => Math.round(v * 10) / 10;
function rings(geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  const out = [];
  for (const poly of polys) {
    const outer = poly[0];
    const area = geoArea({ type: "Polygon", coordinates: [outer] });
    if (area < 2e-6) continue; // islas diminutas
    const pts = [];
    for (const c of outer) {
      const p = proj(c); const q = [round(p[0]), round(p[1])];
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last[0] - q[0], last[1] - q[1]) > 0.8) pts.push(q);
    }
    if (pts.length > 3) out.push(pts);
  }
  return out;
}

const countries = feats.map(f => {
  const c = proj(geoCentroid(f));
  return { ...f.props, centroid: [round(c[0]), round(c[1])], rings: rings(f.geometry) };
}).filter(c => c.rings.length);

writeFileSync("public/assets/latam.json", JSON.stringify({ w: W, h: H, countries }));
console.log("países", countries.length, "alto", H, "puntos", countries.reduce((a, c) => a + c.rings.reduce((b, r) => b + r.length, 0), 0));
