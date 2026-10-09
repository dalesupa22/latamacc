// Exporta la lista de espera del merch a CSV. Uso: node scripts/export-merch.mjs > merch.csv
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(new URL("../data/latamacc.db", import.meta.url).pathname, { readOnly: true });
const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
console.log("email,item,created_at");
for (const r of db.prepare(`SELECT * FROM merch_waitlist ORDER BY created_at`).all())
  console.log([r.email, r.item, new Date(r.created_at).toISOString()].map(q).join(","));
