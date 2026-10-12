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
  // Caribe (islas y territorios)
  "388": ["JM", "Jamaica", "Jamaica"], "780": ["TT", "Trinidad y Tobago", "Trinidad and Tobago"], "044": ["BS", "Bahamas", "Bahamas"],
  "531": ["CW", "Curazao", "Curaçao"], "533": ["AW", "Aruba", "Aruba"], "534": ["SX", "Sint Maarten", "Sint Maarten"],
  "052": ["BB", "Barbados", "Barbados"], "028": ["AG", "Antigua y Barbuda", "Antigua and Barbuda"], "212": ["DM", "Dominica", "Dominica"],
  "308": ["GD", "Granada", "Grenada"], "659": ["KN", "San Cristóbal y Nieves", "Saint Kitts and Nevis"], "662": ["LC", "Santa Lucía", "Saint Lucia"],
  "670": ["VC", "San Vicente y las Granadinas", "Saint Vincent and the Grenadines"], "136": ["KY", "Islas Caimán", "Cayman Islands"],
  "796": ["TC", "Islas Turcas y Caicos", "Turks and Caicos Islands"], "092": ["VG", "Islas Vírgenes Británicas", "British Virgin Islands"],
  "850": ["VI", "Islas Vírgenes de EE. UU.", "U.S. Virgin Islands"], "660": ["AI", "Anguila", "Anguilla"], "500": ["MS", "Montserrat", "Montserrat"],
  "663": ["MF", "San Martín", "Saint Martin"], "652": ["BL", "San Bartolomé", "Saint Barthélemy"],
};
// Territorios que world-atlas incluye dentro de Francia o Países Bajos: se extraen por coordenadas.
const inBox = (poly, [lon0, lon1, lat0, lat1]) => { const [lon, lat] = poly[0][0]; return lon >= lon0 && lon <= lon1 && lat >= lat0 && lat <= lat1; };
const PARTS = {
  "250": [["GP", "Guadalupe", "Guadeloupe", [-62, -60.9, 15.8, 16.6]], ["MQ", "Martinica", "Martinique", [-61.3, -60.7, 14.3, 15]]],
  "528": [["BQ", "Caribe Neerlandés", "Caribbean Netherlands", [-69, -62.8, 11.9, 17.7]]],
};

const feats = [];
for (const f of world.features) {
  if (LATAM[f.id]) feats.push({ ...f, props: { code: LATAM[f.id][0], es: LATAM[f.id][1], en: LATAM[f.id][2], deco: false } });
  if (PARTS[f.id]) for (const [code, es, en, box] of PARTS[f.id]) {
    const polys = f.geometry.coordinates.filter(p => inBox(p, box));
    if (polys.length) feats.push({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: polys }, props: { code, es, en, deco: false } });
  }
  if (f.id === "250") {
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
  const areas = polys.map(p => geoArea({ type: "Polygon", coordinates: [p[0]] }));
  const biggest = Math.max(...areas);
  const out = [];
  for (const [i, poly] of polys.entries()) {
    const outer = poly[0];
    // islas diminutas fuera, salvo la principal de cada territorio (Curazao, San Bartolomé…)
    if (areas[i] < 2e-6 && areas[i] !== biggest) continue;
    const pts = [];
    for (const c of outer) {
      const p = proj(c); const q = [round(p[0]), round(p[1])];
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last[0] - q[0], last[1] - q[1]) > 0.8) pts.push(q);
    }
    if (pts.length > 3) out.push(pts);
    // a esta escala una isla pequeña puede quedar en pocos puntos: se dibuja como un rombo mínimo
    else if (areas[i] === biggest && !out.length) {
      const p = proj(geoCentroid({ type: "Polygon", coordinates: [outer] })), r = 1.6;
      out.push([[round(p[0]), round(p[1] - r)], [round(p[0] + r), round(p[1])], [round(p[0]), round(p[1] + r)], [round(p[0] - r), round(p[1])]]);
    }
  }
  return out;
}

const countries = feats.map(f => {
  const c = proj(geoCentroid(f));
  return { ...f.props, centroid: [round(c[0]), round(c[1])], rings: rings(f.geometry) };
}).filter(c => c.rings.length);

writeFileSync("public/assets/latam.json", JSON.stringify({ w: W, h: H, countries }));
console.log("países", countries.length, "alto", H, "puntos", countries.reduce((a, c) => a + c.rings.reduce((b, r) => b + r.length, 0), 0));
