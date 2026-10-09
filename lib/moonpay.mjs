// MoonPay Commerce (Helio). All merchant credentials stay on the server.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";

export const CONFIG_FILE = process.env.MOONPAY_FILE || join(homedir(), ".config/latamacc/moonpay.json");
export const USD_ID = "637ca18de2997b3a87a566a8";
export const USDC_SOL_ID = "6340313846e4f91b8abc519b";
const HOSTS = new Set(["app.hel.io", "moonpay.hel.io", "pay.hel.io", "hel.io"]);

export function loadMoonpayConfig(file = CONFIG_FILE) {
  try {
    if (statSync(file).mode & 0o077) throw new Error("Merchant configuration must have permissions 600.");
    const c = JSON.parse(readFileSync(file, "utf8"));
    if (!c.enabled) return null;
    if (!c.apiKey || !c.apiSecret || !c.paylinkId || !c.webhookToken || c.pricingCurrencyId !== USD_ID || c.pricingDecimals !== 6 ||
        !Array.isArray(c.recipients) || !c.recipients.length ||
        c.recipients.some(r => !r.walletId || !r.currencyId || !r.publicKey))
      throw new Error("Merchant configuration is incomplete.");
    if (c.environment && c.environment !== "mainnet") throw new Error("Live checkout requires mainnet credentials.");
    return c;
  } catch (e) {
    if (e.code !== "ENOENT") console.error("MoonPay configuration unavailable:", e instanceof SyntaxError ? "Invalid JSON." : e.message);
    return null;
  }
}

export function checkoutUrlOk(value) {
  try { const u = new URL(value); return u.protocol === "https:" && HOSTS.has(u.hostname) && !u.port && !u.username && !u.password; }
  catch { return false; }
}

const positiveInteger = v => /^(0|[1-9]\d*)$/.test(String(v)) && (typeof v !== "number" || Number.isSafeInteger(v));
const sameAmount = (a, b) => positiveInteger(a) && positiveInteger(b) && BigInt(a) === BigInt(b);
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function verifyWebhook(raw, headers, sharedToken) {
  if (!sharedToken || !safeEqual(headers.authorization, `Bearer ${sharedToken}`)) return false;
  const received = String(headers["x-signature"] || "");
  if (!/^[a-fA-F0-9]{64}$/.test(received)) return false;
  const expected = createHmac("sha256", sharedToken).update(raw).digest();
  return timingSafeEqual(Buffer.from(received, "hex"), expected);
}

export function validateCharge(charge, order, config, now = Date.now()) {
  if (charge?.token !== order.charge_token || charge?.id !== order.charge_id ||
      charge?.paylink?.id !== config.paylinkId || charge.paylink.pricingCurrency?.id !== order.payment_currency ||
      !sameAmount(charge.pricingCurrencyRequestAmount, order.payment_amount))
    throw new Error("Payment verification did not match the saved order.");
  const tx = charge.paylinkTx;
  if (tx) {
    if (tx.paylinkId !== config.paylinkId || !tx.id || tx.quantity !== 1 || tx.paymentType !== "PAYLINK")
      throw new Error("Payment transaction did not match the saved order.");
    const meta = tx.meta;
    if (meta?.transactionStatus === "SUCCESS") {
      if (!meta.transactionSignature || !config.recipients.some(r =>
        r.currencyId === meta.currency?.id && r.publicKey === meta.recipientPK))
        throw new Error("Payment recipient did not match the merchant configuration.");
      // meta.amount is NET of fees; the charge's pricingCurrencyRequestAmount is the original cart total.
      return { status: "paid", transactionId: tx.id, signature: meta.transactionSignature };
    }
    if (["FAILED", "CANCELED"].includes(meta?.transactionStatus)) return { status: "payment_failed" };
  }
  return { status: order.expires_at <= now ? "expired" : "awaiting_payment" };
}

export class MoonpayCommerce {
  constructor(config, fetchFn = fetch) { this.config = config; this.fetch = fetchFn; }
  async request(path, body, headers = {}) {
    const u = new URL(`https://api.hel.io/v1${path}`);
    u.searchParams.set("apiKey", this.config.apiKey);
    let response;
    try {
      response = await this.fetch(u, { method: body ? "POST" : "GET", headers: {
        ...headers, authorization: `Bearer ${this.config.apiSecret}`, "content-type": "application/json",
      }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("provider");
      return await response.json();
    } catch { throw new Error("MoonPay is temporarily unavailable. Please try again."); }
  }
  async createCharge(order) {
    const expiresAt = Date.now() + 30 * 60_000;
    const c = await this.request("/charge/api-key", {
      paymentRequestId: this.config.paylinkId,
      requestAmount: order.payment_amount,
      expiresAt: new Date(expiresAt).toISOString(),
      successRedirectUrl: "https://latamacc.si/?merch=return#merch",
      cancelRedirectUrl: "https://latamacc.si/?merch=return#merch",
      prepareRequestBody: { quantity: 1, customerDetails: {
        email: order.email, fullName: order.name, country: order.country,
        additionalJSON: JSON.stringify({ orderId: order.id, item: order.item, size: order.size, qty: order.qty }),
      } },
    });
    if (!c.id || !checkoutUrlOk(c.pageUrl)) throw new Error("MoonPay returned an invalid checkout.");
    const u = new URL(c.pageUrl);
    const token = u.pathname.match(/^\/charge\/([a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})\/?$/i)?.[1];
    if (!token || (c.token && c.token !== token)) throw new Error("MoonPay returned an invalid checkout.");
    return { id: c.id, token, checkoutUrl: c.pageUrl, expiresAt };
  }
  getCharge(token) { return this.request(`/charge/${encodeURIComponent(token)}`); }
}
