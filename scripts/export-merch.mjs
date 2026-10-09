// Exporta las preventas de merch a CSV. Uso: node scripts/export-merch.mjs > merch.csv
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.DATA_DIR ? `${process.env.DATA_DIR}/latamacc.db` : new URL("../data/latamacc.db", import.meta.url).pathname, { readOnly: true });
const cols = ["id", "item", "size", "qty", "name", "email", "country", "status", "total_cents", "payment_tx_id", "payment_signature", "created_at", "paid_at"];
const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
console.log(cols.join(","));
for (const r of db.prepare(`SELECT * FROM merch_orders ORDER BY created_at`).all())
  console.log(cols.map(c => q(["created_at", "paid_at"].includes(c) && r[c] ? new Date(r[c]).toISOString() : r[c])).join(","));
