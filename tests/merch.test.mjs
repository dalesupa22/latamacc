import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { USD_ID, USDC_SOL_ID } from "../lib/moonpay.mjs";

async function launch(dir, config, mock = false) {
  const configFile = join(dir, "moonpay.json"), fixture = join(dir, "fixture.json"), requests = join(dir, "requests.json");
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(fixture, JSON.stringify({ paid: false }));
  const preload = `import{readFileSync,writeFileSync}from'node:fs';import{randomUUID}from'node:crypto';
    const records=[];globalThis.fetch=async(u,init)=>{const url=new URL(u),state=JSON.parse(readFileSync(${JSON.stringify(fixture)},'utf8'));
      if(url.hostname!=='api.hel.io')throw Error('No external requests allowed in test');
      if(url.pathname.endsWith('/expire'))return new Response(null,{status:204});
      if(init.method==='POST'){const b=JSON.parse(init.body),token=randomUUID(),id=randomUUID();records.push({b,token,id});writeFileSync(${JSON.stringify(requests)},JSON.stringify(records));return Response.json({id,pageUrl:'https://app.hel.io/charge/'+token});}
      const token=url.pathname.split('/').at(-1),r=records.find(r=>r.token===token);if(!r)return new Response('',{status:404});
      return Response.json({id:r.id,token,pricingCurrencyRequestAmount:state.wrongAmount?'1':String(BigInt(r.b.requestAmount)*1000000n),
        paylink:{id:'test-paylink',pricingCurrency:{id:${JSON.stringify(USD_ID)}},dynamic:true,disabled:false,inactive:false,
          features:{canChangePrice:false,canChangeQuantity:false},recipients:[{wallet:{id:'main-wallet',publicKey:'MainWallet'},currency:{id:${JSON.stringify(USDC_SOL_ID)}}}]},
        paylinkTx:state.paid?{id:state.txId||('tx-'+token),paylinkId:'test-paylink',quantity:1,paymentType:'PAYLINK',fee:'980000',meta:{transactionStatus:'SUCCESS',transactionSignature:'sig-'+token,amount:'97020000',currency:{id:${JSON.stringify(USDC_SOL_ID)}},recipientPK:state.wrongRecipient?'WrongWallet':'MainWallet'}}:null});};`;
  const args = mock ? ["--import", `data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`, "server.mjs"] : ["server.mjs"];
  const child = spawn(process.execPath, args, { cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DATA_DIR: dir, MOONPAY_FILE: configFile, TURNSTILE_FILE: join(dir, "no-turnstile") }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", c => output += c); child.stderr.on("data", c => output += c);
  const deadline = Date.now() + 10_000;
  while (!/latamacc en http/.test(output)) {
    if (child.exitCode !== null || Date.now() > deadline) throw Error(output || "Server did not start");
    await new Promise(r => setTimeout(r, 20));
  }
  // The live address is logged by the server (PORT=0 selects a free port).
  const base = output.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[0];
  return { child, base, fixture, requests, stop: async () => { child.kill("SIGTERM"); await once(child, "exit"); } };
}

const body = { item: "tee", size: "M", qty: 2, email: "buyer@example.test", name: "Buyer", country: "CO" };
const post = (base, value) => fetch(base + "/api/merch/preorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

test("HTTP reservations without MoonPay preserve data, reject invalid product/qty and report unavailable checkout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "latamacc-reservation-test-"));
  let app;
  try {
    app = await launch(dir, { enabled: false });
    const s = await fetch(app.base + "/api/state").then(r => r.json());
    assert.deepEqual(s.merchPayments, { tee: false, cap: false });
    assert.equal((await fetch(app.base + "/api/health").then(r => r.json())).moonpay, false);
    await new Promise(r => setTimeout(r, 3050));
    for (const qty of [1.5, 0, 11, "bad"]) assert.equal((await post(app.base, { ...body, qty, ft: s.ft })).status, 400);
    assert.equal((await post(app.base, { ...body, item: "__proto__", ft: s.ft })).status, 400);
    const tee = await post(app.base, { ...body, ft: s.ft }); assert.equal(tee.status, 201);
    const j = await tee.json(); assert.equal(j.total, 98); assert.equal(j.payment, undefined);
    assert.equal((await post(app.base, { ...body, item: "cap", size: "ONE", ft: s.ft })).status, 201);
    assert.equal((await fetch(app.base + "/api/merch/status?token=missing")).status, 404);
    assert.equal((await fetch(app.base + "/api/moonpay/webhook", { method: "POST", body: "{}" })).status, 503);
    await app.stop(); app = null;
    const db = new DatabaseSync(join(dir, "latamacc.db"), { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM builders").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM merch_orders WHERE status = 'reserved'").get().n, 2);
    db.close();
  } finally { if (app) await app.stop(); rmSync(dir, { recursive: true }); }
});

test("HTTP checkout verifies provider receipts, capabilities, signed webhooks and transaction uniqueness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "latamacc-checkout-test-"));
  let app;
  try {
    const cfg = { enabled: true, apiKey: "fake-public", apiSecret: "fake-secret", paylinkId: "test-paylink", webhookToken: "test-hook",
      pricingCurrencyId: USD_ID, pricingDecimals: 6, recipients: [{ walletId: "main-wallet", currencyId: USDC_SOL_ID, publicKey: "MainWallet" }] };
    app = await launch(dir, cfg, true);
    const s = await fetch(app.base + "/api/state").then(r => r.json());
    assert.equal(s.merchPayments.tee, true); assert.ok(!JSON.stringify(s).includes("fake-secret"));
    await new Promise(r => setTimeout(r, 3050));
    const result = await post(app.base, { ...body, ft: s.ft, total: 1, requestAmount: "1" }).then(r => r.json());
    assert.equal(result.total, 98); assert.equal(result.payment.status, "awaiting_payment");
    const record = JSON.parse(readFileSync(app.requests))[0];
    assert.equal(record.b.requestAmount, "98"); assert.equal(record.b.prepareRequestBody.quantity, 1);
    const statusUrl = `${app.base}/api/merch/status?token=${result.payment.statusToken}`;
    const awaiting = await fetch(statusUrl).then(r => r.json()); assert.equal(awaiting.status, "awaiting_payment");
    assert.ok(!JSON.stringify(awaiting).includes(body.email));
    assert.equal((await fetch(`${app.base}/api/merch/status?token=${"x".repeat(43)}`)).status, 404);
    const raw = JSON.stringify({ event: "CREATED", chargeToken: record.token });
    assert.equal((await fetch(app.base + "/api/moonpay/webhook", { method: "POST", body: raw })).status, 401);
    writeFileSync(app.fixture, JSON.stringify({ paid: true, wrongAmount: true }));
    assert.equal((await fetch(statusUrl)).status, 502);
    writeFileSync(app.fixture, JSON.stringify({ paid: true, wrongRecipient: true }));
    assert.equal((await fetch(statusUrl)).status, 502);
    writeFileSync(app.fixture, JSON.stringify({ paid: true, txId: "unique-tx" }));
    const signature = createHmac("sha256", cfg.webhookToken).update(raw).digest("hex");
    const hook = await fetch(app.base + "/api/moonpay/webhook", { method: "POST", body: raw,
      headers: { authorization: `Bearer ${cfg.webhookToken}`, "x-signature": signature } });
    assert.equal(hook.status, 200); assert.equal((await fetch(statusUrl).then(r => r.json())).status, "paid");
    assert.equal((await fetch(app.base + "/api/moonpay/webhook", { method: "POST", body: raw,
      headers: { authorization: `Bearer ${cfg.webhookToken}`, "x-signature": signature } })).status, 200);
    writeFileSync(app.fixture, JSON.stringify({ paid: false }));
    const second = await post(app.base, { ...body, ft: s.ft }).then(r => r.json());
    writeFileSync(app.fixture, JSON.stringify({ paid: true, txId: "unique-tx" }));
    assert.equal((await fetch(`${app.base}/api/merch/status?token=${second.payment.statusToken}`)).status, 502);
    await app.stop(); app = null;
    const db = new DatabaseSync(join(dir, "latamacc.db"), { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM merch_orders WHERE status = 'paid'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM builders").get().n, 0);
    db.close();
  } finally { if (app) await app.stop(); rmSync(dir, { recursive: true }); }
});
