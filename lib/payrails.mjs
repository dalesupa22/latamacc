// Payment rails de bounties: quien publica deposita recompensa + comisión de LATAMACC con MoonPay (USDC en
// Solana a la wallet de LATAMACC). LATAMACC custodia el depósito y paga al ganador desde su wallet; los pagos
// salientes los hace una persona y se registran con scripts/bounty-payouts.mjs (aquí no hay llaves de wallet).
// MoonPay Commerce ya no permite dividir pagos en paylinks nuevos, así que la comisión se cobra en el depósito.

export const FEE_BPS = 1000;                    // 10 % sobre la recompensa
export const MIN_FEE_USD = 5, MIN_REWARD_USD = 25, MAX_REWARD_USD = 25_000;
// Montos en USD enteros: el cobro, la comisión y el pago al ganador siempre cuadran sin centavos sueltos.
export function bountyQuote(rewardUsd) {
  if (!Number.isSafeInteger(rewardUsd) || rewardUsd < MIN_REWARD_USD || rewardUsd > MAX_REWARD_USD) throw new Error("Invalid reward.");
  const fee = Math.max(MIN_FEE_USD, Math.ceil(rewardUsd * FEE_BPS / 10_000));
  return { reward: rewardUsd, fee, total: rewardUsd + fee };
}
// "500", "USD 500", "$1,200" -> 500; vacío -> null; otra cosa -> NaN
export function parseRewardUsd(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const m = /^(?:usd\s*|us\$\s*|\$\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.00)?(?:\s*usd)?$/i.exec(v);
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
}
// Helio cobra en USD con 6 decimales.
export const usdToMinor = usd => String(BigInt(usd) * 1_000_000n);

// Dirección pública de Solana (base58, 32 bytes) y firma de transacción (base58, 64 bytes).
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export const solanaAddressOk = v => typeof v === "string" && BASE58.test(v) && v.length >= 32 && v.length <= 44;
export const solanaSignatureOk = v => typeof v === "string" && BASE58.test(v) && v.length >= 64 && v.length <= 90;

// Estados del depósito: awaiting_payment -> paid -> awarded -> paid_out
//                                             \-> refund_requested -> refunded
// payment_failed / expired permiten volver a intentar el depósito.
export const FUNDED = ["paid", "awarded", "refund_requested"];
export const OPEN_LIABILITY = ["paid", "awarded", "refund_requested"];
