// Exporta los builders a CSV (con correos). Uso: node scripts/export.mjs > builders.csv
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(new URL("../data/latamacc.db", import.meta.url).pathname, { readOnly: true });
const cols = ["n", "name", "email", "country", "city", "building", "handle", "created_at"];
const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
console.log(cols.join(","));
for (const r of db.prepare(`SELECT rowid AS n, * FROM builders ORDER BY rowid`).all())
  console.log(cols.map(c => q(c === "created_at" ? new Date(r[c]).toISOString() : r[c])).join(","));
