import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { USD_ID, USDC_SOL_ID } from "../lib/moonpay.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check) {
  const deadline = Date.now() + 8000;
  while (!check()) { if (Date.now() > deadline) assert.fail("Timed out waiting for local mock"); await pause(25); }
}

async function appFixture(t, { mode = "sent", payments = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "latamacc-email-http-test-"));
  const brevoFile = join(dir, "brevo.json"), moonpayFile = join(dir, "moonpay.json"), stateFile = join(dir, "provider-state.json"), mailFile = join(dir, "mail.json");
  writeFileSync(brevoFile, JSON.stringify({ apiKey: "fake-brevo-private", minIntervalMs: 1000 }), { mode: 0o600 });
  writeFileSync(moonpayFile, JSON.stringify(payments ? {
    enabled: true, apiKey: "fake-public", apiSecret: "fake-moonpay-private", paylinkId: "test-paylink", webhookToken: "test-hook",
    pricingCurrencyId: USD_ID, pricingDecimals: 6, recipients: [{ walletId: "test-wallet", currencyId: USDC_SOL_ID, publicKey: "TestWallet" }],
  } : { enabled: false }), { mode: 0o600 });
  writeFileSync(stateFile, JSON.stringify({ mode, paid: false }));
  const preloadFile = join(dir, "mock.mjs");
  writeFileSync(preloadFile, `
    import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    import { randomUUID } from 'node:crypto';
    const stateFile=${JSON.stringify(stateFile)}, mailFile=${JSON.stringify(mailFile)}, charges=[];
    globalThis.fetch=async (input,options={}) => {
      const url=new URL(input), state=JSON.parse(readFileSync(stateFile,'utf8'));
      if(url.href==='https://api.brevo.com/v3/smtp/email') {
        const mails=existsSync(mailFile)?JSON.parse(readFileSync(mailFile,'utf8')):[];
        mails.push(JSON.parse(options.body));writeFileSync(mailFile,JSON.stringify(mails));
        if(state.mode==='hold')return new Promise(()=>{});
        if(state.mode==='reject')return Response.json({message:'raw fake-brevo-private'},{status:400});
        return Response.json({messageId:'<test-'+mails.length+'>'},{status:201});
      }
      if(url.hostname!=='api.hel.io')throw Error('External requests disabled in tests');
      if(url.pathname.endsWith('/expire'))return new Response(null,{status:204});
      if(options.method==='POST') {
        const body=JSON.parse(options.body), token=randomUUID(), id=randomUUID();charges.push({body,token,id});
        return Response.json({id,pageUrl:'https://app.hel.io/charge/'+token});
      }
      const charge=charges.find(c=>c.token===url.pathname.split('/').at(-1));
      if(!charge)return new Response('',{status:404});
      await new Promise(resolve=>setTimeout(resolve,20));
      return Response.json({id:charge.id,token:charge.token,pricingCurrencyRequestAmount:String(BigInt(charge.body.requestAmount)*1000000n),
        paylink:{id:'test-paylink',pricingCurrency:{id:${JSON.stringify(USD_ID)}},dynamic:true,disabled:false,inactive:false,
          features:{canChangePrice:false,canChangeQuantity:false},recipients:[{wallet:{id:'test-wallet',publicKey:'TestWallet'},currency:{id:${JSON.stringify(USDC_SOL_ID)}}}]},
        paylinkTx:state.paid?{id:'transaction-'+charge.token,paylinkId:'test-paylink',quantity:1,paymentType:'PAYLINK',
          meta:{transactionStatus:'SUCCESS',transactionSignature:'signature',currency:{id:${JSON.stringify(USDC_SOL_ID)}},recipientPK:'TestWallet'}}:null});
    };
  `);
  let child, base, output = "";
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
  };
  const start = async () => {
    output = "";
    child = spawn(process.execPath, ["--import", preloadFile, "server.mjs"], {
      cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DATA_DIR: dir, BREVO_ENABLED: "1", BREVO_CONFIG_FILE: brevoFile,
        MOONPAY_FILE: moonpayFile, TURNSTILE_FILE: join(dir, "no-turnstile"), S3_CONFIG_FILE: join(dir, "no-s3") },
    });
    child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
    await eventually(() => {
      if (child.exitCode !== null) assert.fail(output || "Local server did not start");
      base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; return base;
    });
  };
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });
  await start();
  const rows = sql => {
    const db = new DatabaseSync(join(dir, "latamacc.db"), { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  };
  const token = () => {
    const ts = Date.now() - 3500, secret = readFileSync(join(dir, "form-secret"), "utf8").trim();
    return `${ts}.${createHmac("sha256", secret).update(String(ts)).digest("hex").slice(0, 32)}`;
  };
  return { dir, stop, start, rows, get base() { return base; }, get output() { return output; },
    exec: sql => {
      const db = new DatabaseSync(join(dir, "latamacc.db"));
      try { db.exec(sql); } finally { db.close(); }
    },
    setProvider: state => writeFileSync(stateFile, JSON.stringify(state)),
    mails: () => existsSync(mailFile) ? JSON.parse(readFileSync(mailFile, "utf8")) : [],
    post: (path, data) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...data, ft: token() }), signal: AbortSignal.timeout(3000) }),
  };
}

test("HTTP registration is persisted while SMTP hangs; repeat signup is silent and restart does not resend ambiguous mail", async t => {
  const app = await appFixture(t, { mode: "hold" });
  const data = { name: "Test Builder", email: "builder@example.test", country: "CO" };
  const registered = await app.post("/api/register", data);
  assert.equal(registered.status, 201);
  assert.ok(!(await registered.text()).includes(data.email));
  await eventually(() => app.mails().length === 1);
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM builders")[0].n, 1);
  assert.equal(app.rows("SELECT status FROM email_outbox")[0].status, "sending");
  const duplicate = await app.post("/api/register", data);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).existing, true);
  const second = await app.post("/api/register", { ...data, email: "second@example.test" });
  assert.equal(second.status, 201);
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM builders")[0].n, 2);
  assert.equal(app.mails().length, 1);
  const health = await fetch(app.base + "/api/health").then(r => r.json());
  assert.equal(health.email, true);
  assert.ok(!JSON.stringify(health).includes("fake-brevo-private"));
  await app.stop();
  app.setProvider({ mode: "sent", paid: false });
  await app.start();
  await eventually(() => app.rows("SELECT status FROM email_outbox WHERE recipient='second@example.test'")[0].status === "sent");
  assert.equal(app.rows("SELECT status FROM email_outbox WHERE recipient='builder@example.test'")[0].status, "unknown");
  assert.equal(app.mails().length, 2);
  assert.equal(app.mails().filter(m => m.to[0].email === data.email).length, 1);
  assert.ok(!app.output.includes("fake-brevo-private"));
});

test("HTTP reservation remains saved when provider permanently rejects mail; invalid requests create no event", async t => {
  const app = await appFixture(t, { mode: "reject" });
  const body = { item: "tee", size: "M-L", qty: 1, email: "buyer@example.test", country: "CO" };
  assert.equal((await app.post("/api/merch/preorder", { ...body, qty: 0 })).status, 400);
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM email_outbox")[0].n, 0);
  assert.equal((await app.post("/api/merch/preorder", body)).status, 201);
  await eventually(() => app.rows("SELECT status FROM email_outbox")[0]?.status === "failed");
  assert.equal(app.rows("SELECT status FROM merch_orders")[0].status, "reserved");
  assert.equal(app.mails().length, 1);
  assert.ok(app.mails()[0].textContent.includes("No payment has been collected."));
  assert.ok(!app.output.includes("raw fake-brevo-private"));
});

test("pending checkout sends nothing; concurrent verified status and repeated webhook enqueue exactly one paid confirmation", async t => {
  const app = await appFixture(t, { payments: true });
  const result = await app.post("/api/merch/preorder", { item: "cap", size: "ONE", qty: 1, email: "buyer@example.test", country: "CO" }).then(r => r.json());
  assert.equal(result.payment.status, "awaiting_payment");
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM email_outbox")[0].n, 0);
  app.setProvider({ mode: "sent", paid: true });
  const statusUrl = app.base + "/api/merch/status?token=" + result.payment.statusToken;
  const results = await Promise.all([fetch(statusUrl), fetch(statusUrl)]);
  for (const response of results) { assert.equal(response.status, 200); assert.equal((await response.json()).status, "paid"); }
  const token = app.rows("SELECT charge_token FROM merch_orders")[0].charge_token;
  const raw = JSON.stringify({ event: "CREATED", chargeToken: token });
  const hook = await fetch(app.base + "/api/moonpay/webhook", { method: "POST", body: raw,
    headers: { authorization: "Bearer test-hook", "x-signature": createHmac("sha256", "test-hook").update(raw).digest("hex") } });
  assert.equal(hook.status, 200);
  await eventually(() => app.rows("SELECT status FROM email_outbox")[0]?.status === "sent");
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM email_outbox")[0].n, 1);
  assert.equal(app.mails().length, 1);
  assert.ok(app.mails()[0].textContent.includes("verified payment"));
});

const rejectOutbox = "CREATE TRIGGER reject_outbox BEFORE INSERT ON email_outbox BEGIN SELECT RAISE(ABORT,'Synthetic queue failure'); END";

test("signup and reservation roll back if their email event cannot be persisted", async t => {
  const app = await appFixture(t);
  app.exec(rejectOutbox);
  const registration = { name: "Test Builder", email: "builder@example.test", country: "CO" };
  assert.equal((await app.post("/api/register", registration)).status, 500);
  assert.equal((await app.post("/api/merch/preorder", { item: "cap", size: "ONE", qty: 1, email: "buyer@example.test", country: "CO" })).status, 500);
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM builders")[0].n, 0);
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM merch_orders")[0].n, 0);
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM email_outbox")[0].n, 0);
  assert.equal(app.mails().length, 0);
  app.exec("DROP TRIGGER reject_outbox");
  assert.equal((await app.post("/api/register", registration)).status, 201);
  await eventually(() => app.rows("SELECT status FROM email_outbox")[0]?.status === "sent");
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM builders")[0].n, 1);
  assert.equal(app.mails().length, 1);
});

test("verified payment and confirmation event commit together, allowing safe reconciliation after queue failure", async t => {
  const app = await appFixture(t, { payments: true });
  app.exec(rejectOutbox);
  const response = await app.post("/api/merch/preorder", { item: "cap", size: "ONE", qty: 1, email: "buyer@example.test", country: "CO" });
  assert.equal(response.status, 201); // Pending checkout does not enqueue mail.
  const result = await response.json();
  app.setProvider({ mode: "sent", paid: true });
  const statusUrl = app.base + "/api/merch/status?token=" + result.payment.statusToken;
  assert.equal((await fetch(statusUrl)).status, 502);
  assert.deepEqual({ ...app.rows("SELECT status,paid_at,payment_tx_id FROM merch_orders")[0] },
    { status: "awaiting_payment", paid_at: null, payment_tx_id: null });
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM email_outbox")[0].n, 0);
  assert.equal(app.mails().length, 0);
  app.exec("DROP TRIGGER reject_outbox");
  const confirmed = await fetch(statusUrl);
  assert.equal(confirmed.status, 200); assert.equal((await confirmed.json()).status, "paid");
  await eventually(() => app.rows("SELECT status FROM email_outbox")[0]?.status === "sent");
  assert.equal(app.rows("SELECT COUNT(*) AS n FROM email_outbox")[0].n, 1);
  assert.equal(app.mails().length, 1);
});
