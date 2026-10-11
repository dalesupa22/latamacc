import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { USD_ID, USDC_SOL_ID } from "../lib/moonpay.mjs";
import { bountyQuote, parseRewardUsd, solanaAddressOk, solanaSignatureOk, usdToMinor } from "../lib/payrails.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const pause = ms => new Promise(r => setTimeout(r, ms));
const WALLET = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const SIG = "5".repeat(30) + "VhGzG8iQZB1kLwHkcYw2ZJqR6g5d7Q2ab3cNgYq3gEbqKXn4aB7cD";

test("fee quote, reward parsing and Solana formats", () => {
  assert.deepEqual(bountyQuote(500), { reward: 500, fee: 50, total: 550 });
  assert.deepEqual(bountyQuote(25), { reward: 25, fee: 5, total: 30 }, "minimum fee");
  assert.deepEqual(bountyQuote(333), { reward: 333, fee: 34, total: 367 }, "fee rounds up to whole USD");
  for (const bad of [24, 25_001, 10.5, NaN]) assert.throws(() => bountyQuote(bad));
  assert.equal(usdToMinor(550), "550000000");
  assert.equal(parseRewardUsd(""), null);
  assert.equal(parseRewardUsd("USD 1,200"), 1200);
  assert.equal(parseRewardUsd("$500"), 500);
  assert.ok(Number.isNaN(parseRewardUsd("10% of the deal")));
  assert.ok(solanaAddressOk(WALLET));
  assert.ok(!solanaAddressOk("0x1234567890abcdef1234567890abcdef12345678"));
  assert.ok(solanaSignatureOk(SIG));
  assert.ok(!solanaSignatureOk("short"));
});

// Servidor aislado con MoonPay simulado (sin red): los cobros quedan en un archivo y "paid" se activa desde la prueba.
async function launch(t, escrow = true) {
  const dir = mkdtempSync(join(tmpdir(), "latamacc-escrow-test-"));
  const configFile = join(dir, "moonpay.json"), fixture = join(dir, "fixture.json"), requests = join(dir, "requests.json");
  writeFileSync(configFile, JSON.stringify({ enabled: true, apiKey: "fake-public", apiSecret: "fake-secret", paylinkId: "test-paylink", webhookToken: "test-hook",
    pricingCurrencyId: USD_ID, pricingDecimals: 6, recipients: [{ walletId: "main-wallet", currencyId: USDC_SOL_ID, publicKey: "MainWallet" }] }), { mode: 0o600 });
  writeFileSync(fixture, JSON.stringify({ paid: [] }));
  writeFileSync(requests, "[]");
  const preload = `import{readFileSync,writeFileSync}from'node:fs';import{randomUUID}from'node:crypto';
    globalThis.fetch=async(u,init)=>{const url=new URL(u),state=JSON.parse(readFileSync(${JSON.stringify(fixture)},'utf8')),records=JSON.parse(readFileSync(${JSON.stringify(requests)},'utf8'));
      if(url.hostname!=='api.hel.io')throw Error('No external requests allowed in test');
      if(url.pathname.endsWith('/expire'))return new Response(null,{status:204});
      if(init.method==='POST'){const b=JSON.parse(init.body),token=randomUUID(),id=randomUUID();records.push({b,token,id});writeFileSync(${JSON.stringify(requests)},JSON.stringify(records));return Response.json({id,pageUrl:'https://app.hel.io/charge/'+token});}
      const token=url.pathname.split('/').at(-1),r=records.find(r=>r.token===token);if(!r)return new Response('',{status:404});
      const paid=state.paid.includes(token);
      return Response.json({id:r.id,token,pricingCurrencyRequestAmount:String(BigInt(r.b.requestAmount)*1000000n),
        paylink:{id:'test-paylink',pricingCurrency:{id:${JSON.stringify(USD_ID)}},dynamic:true,disabled:false,inactive:false,
          features:{canChangePrice:false,canChangeQuantity:false},recipients:[{wallet:{id:'main-wallet',publicKey:'MainWallet'},currency:{id:${JSON.stringify(USDC_SOL_ID)}}}]},
        paylinkTx:paid?{id:'tx-'+token,paylinkId:'test-paylink',quantity:1,paymentType:'PAYLINK',meta:{transactionStatus:'SUCCESS',transactionSignature:'sig-'+token,currency:{id:${JSON.stringify(USDC_SOL_ID)}},recipientPK:'MainWallet'}}:null});};`;
  const child = spawn(process.execPath, ["--import", `data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`, "server.mjs"], { cwd: ROOT,
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DATA_DIR: dir, MOONPAY_FILE: configFile, TURNSTILE_FILE: join(dir, "no-turnstile"),
      S3_CONFIG_FILE: join(dir, "no-s3"), BREVO_ENABLED: "0", BOUNTY_ESCROW: escrow ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", base;
  child.stdout.on("data", d => output += d); child.stderr.on("data", d => output += d);
  const deadline = Date.now() + 10_000;
  while (!(base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0])) {
    if (child.exitCode !== null || Date.now() > deadline) throw Error(output || "Server did not start");
    await pause(20);
  }
  t.after(async () => { if (child.exitCode === null) { const e = once(child, "exit"); child.kill("SIGTERM"); await e; } rmSync(dir, { recursive: true, force: true }); });
  const ft = () => {
    const ts = Date.now() - 3500, secret = readFileSync(join(dir, "form-secret"), "utf8").trim();
    return `${ts}.${createHmac("sha256", secret).update(String(ts)).digest("hex").slice(0, 32)}`;
  };
  const call = (path, { method = "GET", body, session, headers = {}, raw } = {}) => fetch(base + path, { method,
    headers: { ...(session ? { authorization: `Bearer ${session}` } : {}), ...(body || raw ? { "content-type": "application/json" } : {}), ...headers },
    body: raw ?? (body && JSON.stringify(body)) });
  const db = () => new DatabaseSync(join(dir, "latamacc.db"));
  // sesión de miembro sin pasar por el correo: se guarda solo el hash, igual que el servidor
  const sessionFor = email => {
    const token = randomBytes(32).toString("base64url"), d = db();
    try {
      const { id } = d.prepare("SELECT id FROM builders WHERE email = ?").get(email);
      d.prepare("INSERT INTO member_tokens (hash,builder_id,kind,created_at,expires_at) VALUES (?,?,'session',?,?)")
        .run(createHash("sha256").update(token).digest("hex"), id, Date.now(), Date.now() + 3600_000);
    } finally { d.close(); }
    return token;
  };
  const charges = () => JSON.parse(readFileSync(requests, "utf8"));
  const pay = token => { const s = JSON.parse(readFileSync(fixture, "utf8")); s.paid.push(token); writeFileSync(fixture, JSON.stringify(s)); };
  return { dir, call, ft, sessionFor, charges, pay, db, output: () => output };
}

test("bounty escrow: deposit reward + fee, verify with MoonPay, award a winner, refund on close and record payouts", async t => {
  const a = await launch(t);
  for (const [name, email] of [["Ana", "ana@example.test"], ["Beto", "beto@example.test"]])
    assert.equal((await a.call("/api/register", { method: "POST", body: { name, email, country: "CO", ft: a.ft() } })).status, 201);
  const ana = a.sessionFor("ana@example.test"), beto = a.sessionFor("beto@example.test");
  const state = await a.call("/api/state").then(r => r.json());
  assert.equal(state.bountyPayments.enabled, true);
  assert.equal(state.bountyPayments.feeBps, 1000);

  const post = (session, body) => a.call("/api/me/bounties", { method: "POST", session, body: { category: "intro", submit: "ana@example.test", ...body } });
  assert.equal((await post(ana, { title: "Too small", reward_usd: "10" })).status, 400);
  assert.equal((await post(ana, { title: "Not a number", reward_usd: "lots" })).status, 400);
  const posted = await post(ana, { title: "Intro to a bank CTO", reward_usd: "USD 500" }).then(r => r.json());
  const bounty = posted.me.bounties[0];
  assert.deepEqual([bounty.reward, bounty.rewardUsd, bounty.funded, bounty.funding], ["USD 500", 500, false, null]);
  const textOnly = (await post(ana, { title: "Video", category: "content", reward: "10% of the first deal" }).then(r => r.json())).me.bounties.find(x => x.title === "Video");
  assert.equal(textOnly.rewardUsd, null);
  assert.equal((await a.call(`/api/me/bounties/${textOnly.id}/fund`, { method: "POST", session: ana })).status, 400);

  // solo el autor deposita; el cobro es recompensa + 10 %
  assert.equal((await a.call(`/api/me/bounties/${bounty.id}/fund`, { method: "POST", session: beto })).status, 404);
  const funding = (await a.call(`/api/me/bounties/${bounty.id}/fund`, { method: "POST", session: ana }).then(r => r.json())).funding;
  assert.deepEqual([funding.status, funding.reward, funding.fee, funding.total], ["awaiting_payment", 500, 50, 550]);
  assert.match(funding.checkoutUrl, /^https:\/\/app\.hel\.io\/charge\//);
  const [charge] = a.charges();
  assert.equal(charge.b.requestAmount, "550");
  assert.equal(charge.b.successRedirectUrl, `https://latamacc.si/?bounty=${bounty.id}#bounties`);
  assert.equal(JSON.parse(charge.b.prepareRequestBody.customerDetails.additionalJSON).fee, 50);
  // un segundo clic reutiliza el mismo checkout
  const again = await a.call(`/api/me/bounties/${bounty.id}/fund`, { method: "POST", session: ana });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).funding.checkoutUrl, funding.checkoutUrl);
  assert.equal(a.charges().length, 1);
  assert.equal((await a.call(`/api/me/bounties/${bounty.id}/award`, { method: "POST", session: ana, body: { winner: "Beto", wallet: WALLET } })).status, 409, "no award before the deposit");

  // pagado: el webhook firmado dispara la verificación con MoonPay
  a.pay(charge.token);
  const raw = JSON.stringify({ event: "CREATED", chargeToken: charge.token });
  const hook = await a.call("/api/moonpay/webhook", { method: "POST", raw, headers: { authorization: "Bearer test-hook", "x-signature": createHmac("sha256", "test-hook").update(raw).digest("hex") } });
  assert.equal(hook.status, 200);
  const status = await a.call(`/api/me/bounties/${bounty.id}/fund`, { session: ana }).then(r => r.json());
  assert.equal(status.funding.status, "paid");
  assert.equal(status.funding.checkoutUrl, null);
  const pub = (await a.call("/api/bounties").then(r => r.json())).bounties.find(x => x.id === bounty.id);
  assert.equal(pub.funded, true);
  assert.equal(pub.funding, undefined, "deposit details stay private");
  assert.equal((await a.call(`/api/me/bounties/${bounty.id}/fund`, { method: "POST", session: ana })).status, 409, "no double deposit");
  assert.equal((await a.call("/api/me", { method: "DELETE", session: ana })).status, 409, "a member with money in escrow can't vanish");

  // vencido con depósito: sigue en "mis bounties" para poder elegir ganador
  { const d = a.db(); d.prepare("UPDATE bounties SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, bounty.id); d.close(); }
  assert.ok(!(await a.call("/api/bounties").then(r => r.json())).bounties.some(x => x.id === bounty.id));
  assert.ok((await a.call("/api/me", { session: ana }).then(r => r.json())).me.bounties.some(x => x.id === bounty.id && x.funded));

  // ganador: wallet de Solana obligatoria; el bounty se cierra y el pago queda en la cola
  assert.equal((await a.call(`/api/me/bounties/${bounty.id}/award`, { method: "POST", session: ana, body: { winner: "Beto", wallet: "0xabc" } })).status, 400);
  assert.equal((await a.call(`/api/me/bounties/${bounty.id}/award`, { method: "POST", session: beto, body: { winner: "Beto", wallet: WALLET } })).status, 409);
  const awarded = await a.call(`/api/me/bounties/${bounty.id}/award`, { method: "POST", session: ana, body: { winner: "Beto", wallet: WALLET } }).then(r => r.json());
  assert.ok(!awarded.me.bounties.some(x => x.id === bounty.id));
  assert.deepEqual([awarded.me.escrow[0].status, awarded.me.escrow[0].winner, awarded.me.escrow[0].wallet], ["awarded", "Beto", WALLET]);

  // otro bounty depositado y cerrado sin ganador pide reembolso
  const second = (await post(ana, { title: "Product teardown", category: "product", reward_usd: "100" }).then(r => r.json())).me.bounties.find(x => x.title === "Product teardown");
  await a.call(`/api/me/bounties/${second.id}/fund`, { method: "POST", session: ana });
  a.pay(a.charges()[1].token);
  assert.equal((await a.call(`/api/me/bounties/${second.id}/fund`, { session: ana }).then(r => r.json())).funding.status, "paid");
  assert.equal((await a.call(`/api/me/bounties/${second.id}/close`, { method: "POST", session: ana })).status, 200);

  // la cola de pagos: listar, registrar el pago al ganador y el reembolso
  const cli = (...args) => execFileSync(process.execPath, ["scripts/bounty-payouts.mjs", ...args], { cwd: ROOT, env: { ...process.env, DATA_DIR: a.dir }, encoding: "utf8" });
  const list = cli();
  assert.match(list, /to winners: USD 500 · refunds: USD 100/);
  assert.match(list, new RegExp(`pay USD 500 to Beto → ${WALLET}`));
  const d = a.db(), ids = Object.fromEntries(d.prepare("SELECT status, id FROM bounty_funds").all().map(r => [r.status, r.id])); d.close();
  assert.throws(() => cli("paid", ids.awarded, "not-a-signature"));
  assert.throws(() => cli("paid", ids.refund_requested, SIG), "only awarded deposits are paid to winners");
  assert.match(cli("paid", ids.awarded, SIG), /Recorded paid_out/);
  assert.match(cli("refunded", ids.refund_requested, SIG), /Recorded refunded/);
  const me = await a.call("/api/me", { session: ana }).then(r => r.json());
  assert.deepEqual(me.me.escrow.map(f => f.status).sort(), ["paid_out", "refunded"]);
  assert.equal((await a.call("/api/me", { method: "DELETE", session: ana })).status, 200, "settled escrow no longer blocks removal");
  assert.ok(!a.output().includes("fake-secret"));
});

test("escrow stays off unless BOUNTY_ESCROW=1, even with MoonPay configured", async t => {
  const a = await launch(t, false);
  assert.equal((await a.call("/api/register", { method: "POST", body: { name: "Ana", email: "ana@example.test", country: "CO", ft: a.ft() } })).status, 201);
  const ana = a.sessionFor("ana@example.test");
  assert.equal((await a.call("/api/state").then(r => r.json())).bountyPayments.enabled, false);
  const b = (await a.call("/api/me/bounties", { method: "POST", session: ana, body: { title: "Intro", category: "intro", reward_usd: "500", submit: "ana@example.test" } }).then(r => r.json())).me.bounties[0];
  assert.equal((await a.call(`/api/me/bounties/${b.id}/fund`, { method: "POST", session: ana })).status, 503);
  assert.equal(a.charges().length, 0);
});
