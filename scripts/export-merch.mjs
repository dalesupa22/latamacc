// Exporta las reservas de merch a CSV. Uso: node scripts/export-merch.mjs > merch.csv
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(new URL("../data/latamacc.db", import.meta.url).pathname, { readOnly: true });
const cols = ["item", "size", "qty", "name", "email", "country", "created_at"];
const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
console.log(cols.join(","));
for (const r of db.prepare(`SELECT * FROM merch_orders ORDER BY created_at`).all())
  console.log(cols.map(c => q(c === "created_at" ? new Date(r[c]).toISOString() : r[c])).join(","));
