// Cola de pagos del escrow de bounties. LATAMACC paga a mano desde su wallet (USDC en Solana) y registra aquí la firma.
// Uso:
//   node scripts/bounty-payouts.mjs                      lista lo que hay en custodia, ganadores por pagar y reembolsos pedidos
//   node scripts/bounty-payouts.mjs paid <id> <firma>     registra el pago al ganador (awarded -> paid_out)
//   node scripts/bounty-payouts.mjs refunded <id> <firma> registra el reembolso al autor (refund_requested -> refunded)
// El servidor puede seguir corriendo: SQLite en WAL admite esta escritura y el próximo respaldo la incluye.
import { DatabaseSync } from "node:sqlite";
import { solanaSignatureOk } from "../lib/payrails.mjs";

const file = process.env.DATA_DIR ? `${process.env.DATA_DIR}/latamacc.db` : new URL("../data/latamacc.db", import.meta.url).pathname;
const [command, id, signature] = process.argv.slice(2);
const db = new DatabaseSync(file, { readOnly: !command });
db.exec("PRAGMA busy_timeout = 5000");

if (!command) {
  const rows = db.prepare(`SELECT f.*, b.name AS poster, b.email AS poster_email FROM bounty_funds f LEFT JOIN builders b ON b.id = f.builder_id
    WHERE f.status IN ('paid','awarded','refund_requested') ORDER BY f.status, f.paid_at`).all();
  const sum = s => rows.filter(r => r.status === s).reduce((n, r) => n + r.reward_usd, 0);
  console.log(`In escrow: USD ${sum("paid")} · to winners: USD ${sum("awarded")} · refunds: USD ${sum("refund_requested")}`);
  for (const r of rows) {
    const to = r.status === "awarded" ? `pay USD ${r.reward_usd} to ${r.winner_name} → ${r.winner_wallet}`
      : r.status === "refund_requested" ? `refund USD ${r.reward_usd} to ${r.poster ?? "removed member"} <${r.poster_email ?? "?"}> (ask for their Solana wallet)`
      : `held USD ${r.reward_usd} (fee USD ${r.fee_usd} earned)`;
    console.log(`${r.id}  ${r.status.padEnd(16)} ${r.title.slice(0, 50).padEnd(50)}  ${to}  [deposit ${r.payment_signature}]`);
  }
  const fees = db.prepare("SELECT COALESCE(SUM(fee_usd),0) n FROM bounty_funds WHERE status IN ('paid','awarded','paid_out')").get().n;
  console.log(`Fees earned on funded bounties: USD ${fees} (refunds keep the fee unless you decide otherwise).`);
} else {
  const next = { paid: ["awarded", "paid_out"], refunded: ["refund_requested", "refunded"] }[command];
  if (!next || !/^[0-9a-f-]{36}$/.test(id ?? "") || !solanaSignatureOk(signature)) {
    console.error("Usage: node scripts/bounty-payouts.mjs paid|refunded <funding id> <solana transaction signature>");
    process.exit(1);
  }
  const r = db.prepare(`UPDATE bounty_funds SET status = ?, settle_signature = ?, settled_at = ? WHERE id = ? AND status = ?`)
    .run(next[1], signature, Date.now(), id, next[0]);
  if (!r.changes) { console.error(`No ${next[0]} deposit with that id.`); process.exit(1); }
  console.log(`Recorded ${next[1]} for ${id}.`);
}
