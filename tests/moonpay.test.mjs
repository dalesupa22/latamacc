import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { MoonpayCommerce, USD_ID, USDC_SOL_ID, loadMoonpayConfig, validateCharge, verifyWebhook, checkoutUrlOk } from "../lib/moonpay.mjs";

const token = "11111111-2222-4333-8444-555555555555";
const config = { enabled: true, apiKey: "public-test", apiSecret: "secret-test", paylinkId: "paylink-test", webhookToken: "hook-test",
  pricingCurrencyId: USD_ID, pricingDecimals: 6, recipients: [{ walletId: "main-wallet", currencyId: USDC_SOL_ID, publicKey: "MainWallet" }] };
const order = { id: "order-test", item: "tee", size: "M", qty: 2, email: "buyer@example.test", name: "Test Buyer", country: "CO",
  charge_token: token, charge_id: "charge-test", payment_amount: "98000000", payment_currency: USD_ID, expires_at: 10_000 };
const receipt = () => ({ id: "charge-test", token, pricingCurrencyRequestAmount: "98000000", requestAmount: "98000000",
  paylink: { id: config.paylinkId, pricingCurrency: { id: USD_ID } }, paylinkTx: { id: "tx-test", paylinkId: config.paylinkId,
    quantity: 1, paymentType: "PAYLINK", fee: "980000", meta: { transactionStatus: "SUCCESS", transactionSignature: "chain-signature",
      amount: "97020000", currency: { id: USDC_SOL_ID }, recipientPK: "MainWallet" } } });

test("charge creation sends trusted full-cart amount, quantity 1 and metadata; supports pageUrl without token", async () => {
  const client = new MoonpayCommerce(config, async (url, init) => {
    assert.equal(url.pathname, "/v1/charge/api-key");
    assert.equal(url.searchParams.get("apiKey"), config.apiKey);
    assert.equal(init.headers.authorization, `Bearer ${config.apiSecret}`);
    const b = JSON.parse(init.body);
    assert.equal(b.requestAmount, "98000000");
    assert.equal(b.prepareRequestBody.quantity, 1);
    assert.equal(JSON.parse(b.prepareRequestBody.customerDetails.additionalJSON).qty, 2);
    assert.equal(b.successRedirectUrl, "https://latamacc.si/?merch=return#merch");
    assert.ok(Number.isFinite(Date.parse(b.expiresAt)));
    return Response.json({ id: "charge-test", pageUrl: `https://app.hel.io/charge/${token}` });
  });
  const result = await client.createCharge(order);
  assert.equal(result.token, token);
  assert.equal(result.id, "charge-test");
});

test("SUCCESS is verified against original gross amount, with net provider fees allowed", () => {
  assert.deepEqual(validateCharge(receipt(), order, config, 20_000), { status: "paid", transactionId: "tx-test", signature: "chain-signature" });
});

test("receipt mismatches reject altered totals, associations, recipients and currencies", async t => {
  const cases = {
    amount: c => c.pricingCurrencyRequestAmount = "97020000", token: c => c.token = "another",
    charge: c => c.id = "another", paylink: c => c.paylink.id = "another", pricing: c => c.paylink.pricingCurrency.id = "another",
    txPaylink: c => c.paylinkTx.paylinkId = "another", quantity: c => c.paylinkTx.quantity = 2,
    recipient: c => c.paylinkTx.meta.recipientPK = "LegacyOrAttacker", currency: c => c.paylinkTx.meta.currency.id = "wrong-chain",
    signature: c => c.paylinkTx.meta.transactionSignature = "", unsafeAmount: c => c.pricingCurrencyRequestAmount = 9800000000000000000,
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => {
    const c = receipt(); mutate(c); assert.throws(() => validateCharge(c, order, config));
  });
});

test("unpaid, failed and expired charge states cannot become paid", () => {
  const c = receipt(); c.paylinkTx = null;
  assert.equal(validateCharge(c, order, config, 1).status, "awaiting_payment");
  assert.equal(validateCharge(c, order, config, 20_000).status, "expired");
  c.paylinkTx = receipt().paylinkTx; c.paylinkTx.meta.transactionStatus = "FAILED";
  assert.equal(validateCharge(c, order, config, 1).status, "payment_failed");
});

test("webhook requires Bearer and a valid raw-body HMAC", () => {
  const raw = Buffer.from('{ "event": "CREATED", "chargeToken": "test" }');
  const headers = { authorization: "Bearer hook-test", "x-signature": createHmac("sha256", "hook-test").update(raw).digest("hex") };
  assert.equal(verifyWebhook(raw, headers, "hook-test"), true);
  assert.equal(verifyWebhook(Buffer.from(JSON.stringify(JSON.parse(raw))), headers, "hook-test"), false);
  assert.equal(verifyWebhook(raw, { ...headers, authorization: "Bearer wrong" }, "hook-test"), false);
  assert.equal(verifyWebhook(raw, { ...headers, "x-signature": "00" }, "hook-test"), false);
});

test("checkout URLs reject arbitrary hosts, userinfo, ports, and response-token mismatch", async () => {
  for (const url of ["http://app.hel.io/", "https://app.hel.io.evil.test/", "https://app.hel.io:444/", "https://user:pass@app.hel.io/"])
    assert.equal(checkoutUrlOk(url), false);
  const client = new MoonpayCommerce(config, async () => Response.json({ id: "charge-test", token: "wrong", pageUrl: `https://app.hel.io/charge/${token}` }));
  await assert.rejects(() => client.createCharge(order), /invalid checkout/);
});

test("configuration requires private permissions and webhook readiness", () => {
  const dir = mkdtempSync(join(tmpdir(), "latamacc-config-test-")), file = join(dir, "moonpay.json");
  const originalError = console.error;
  try {
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    assert.equal(loadMoonpayConfig(file).paylinkId, config.paylinkId);
    console.error = () => {};
    chmodSync(file, 0o644); assert.equal(loadMoonpayConfig(file), null);
    chmodSync(file, 0o600); writeFileSync(file, JSON.stringify({ ...config, webhookToken: "" }));
    assert.equal(loadMoonpayConfig(file), null);
  } finally { console.error = originalError; rmSync(dir, { recursive: true }); }
});

test("provider errors never expose keys or upstream response bodies", async () => {
  const client = new MoonpayCommerce(config, async () => Response.json({ message: "secret-test" }, { status: 401 }));
  await assert.rejects(() => client.getCharge(token), e => !e.message.includes(config.apiSecret) && /temporarily unavailable/.test(e.message));
});
