import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Exercise the actual checkout handlers without starting the map, a server,
// a real browser, or making any network/payment requests.
const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const start = source.indexOf("// ---------- merch y checkout ----------");
const selection = source.indexOf("function pickItem(li)", start);
const submit = source.indexOf('po.addEventListener("submit",', selection);
const end = source.indexOf("// ---------- arranque ----------", submit);
assert.ok(start >= 0 && selection > start && submit > selection && end > submit);
const checkoutSource = source.slice(start, selection) + source.slice(submit, end);

const order = {
  item: "tee", size: "M", qty: 1, total: 49,
  payment: { checkoutUrl: "https://pay.hel.io/checkout/example", statusToken: "status-token", status: "awaiting_payment" },
};

function harness({ persisted = null, storageFails = false } = {}) {
  const elements = new Map();
  const storage = new Map(persisted ? [["latamacc-checkout", JSON.stringify(persisted)]] : []);
  const requests = [], navigation = [];
  let reply = { ok: true, json: async () => order };
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      hidden: ["#payment-status", "#payment-resume"].includes(id),
      disabled: false, textContent: "", focusCount: 0, handlers: {},
      addEventListener(type, handler) { this.handlers[type] = handler; },
      focus() { this.focusCount++; },
    });
    return elements.get(id);
  }
  const form = element("#preorder");
  form.fields = { item: "tee", size: "M", qty: "1", email: "buyer@example.test", country: "CO", name: "Buyer" };
  for (const key of ["item", "qty", "email", "name"]) {
    form[key] = { value: form.fields[key], focusCount: 0, focus() { this.focusCount++; } };
  }
  const context = vm.createContext({
    URL, $: element,
    FormData: class {
      constructor(form) { this.entries = Object.entries(form.fields); }
      [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
    },
    sessionStorage: {
      getItem: key => storage.get(key) || null,
      setItem(key, value) { if (storageFails) throw new Error("Storage unavailable"); storage.set(key, value); },
      removeItem(key) { if (storageFails) throw new Error("Storage unavailable"); storage.delete(key); },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (reply instanceof Error) throw reply;
      return reply;
    },
    location: { assign: url => navigation.push(url) },
    guarded: data => data,
    resetGuard() {},
  });
  vm.runInContext(checkoutSource, context);
  return {
    element, form, storage, requests, navigation,
    run: expression => vm.runInContext(expression, context),
    submit: () => form.handlers.submit({ preventDefault() {} }),
    reply(value, ok = true) { reply = value instanceof Error ? value : { ok, json: async () => value }; },
  };
}

test("checkout accepts only HTTPS provider hosts without credentials or unusual ports", () => {
  const ui = harness();
  for (const host of ["moonpay.hel.io", "pay.hel.io", "app.hel.io", "hel.io"]) {
    assert.equal(ui.run(`checkoutUrl(${JSON.stringify(`https://${host}/checkout/example`)})`), `https://${host}/checkout/example`);
  }
  assert.equal(ui.run('checkoutUrl("https://pay.hel.io:443/example")'), "https://pay.hel.io/example");
  for (const url of ["", "not a URL", "http://pay.hel.io/example", "https://pay.hel.io:444/example", "https://pay.hel.io.evil.test/example", "https://evil.test/?next=https://pay.hel.io", "https://user:password@pay.hel.io/example", "javascript:alert(1)"]) {
    assert.equal(ui.run(`checkoutUrl(${JSON.stringify(url)})`), null, url);
  }
});

test("a valid checkout is stored before redirect and opens accessible recovery UI", async () => {
  const ui = harness();
  await ui.submit();
  const saved = JSON.parse(ui.storage.get("latamacc-checkout"));
  assert.equal(saved.statusToken, order.payment.statusToken);
  assert.equal(saved.status, "awaiting_payment");
  assert.deepEqual(ui.navigation, [order.payment.checkoutUrl]);
  assert.equal(ui.form.hidden, true);
  assert.equal(ui.element("#payment-status").hidden, false);
  assert.equal(ui.element("#payment-title").focusCount, 1);
  assert.equal(ui.element("#po-btn").disabled, false);
  assert.equal(ui.requests[0].url, "/api/merch/preorder");
});

test("unsafe or missing provider URLs never redirect or create a recovery token", async () => {
  for (const checkoutUrl of ["", "https://evil.test/checkout", "https://pay.hel.io:444/checkout"]) {
    const ui = harness();
    ui.reply({ ...order, payment: { ...order.payment, checkoutUrl } });
    await ui.submit();
    assert.deepEqual(ui.navigation, []);
    assert.equal(ui.storage.has("latamacc-checkout"), false);
    assert.equal(ui.form.hidden, false);
    assert.match(ui.element("#po-msg").textContent, /Checkout is unavailable/);
  }
});

test("storage failure keeps the page open and supports payment verification in memory", async () => {
  const ui = harness({ storageFails: true });
  await ui.submit();
  assert.deepEqual(ui.navigation, []);
  assert.equal(ui.element("#payment-resume").href, order.payment.checkoutUrl);
  assert.equal(ui.element("#payment-resume").hidden, false);
  assert.match(ui.element("#payment-detail").textContent, /Keep this page open/);
  const resume = html.match(/<a\b[^>]*id="payment-resume"[^>]*>/)?.[0];
  assert.match(resume, /target="_blank"/);
  assert.match(resume, /rel="[^\"]*noopener[^\"]*"/);
  assert.match(html, /id="payment-title"[^>]*tabindex="-1"/);
  ui.reply({ status: "paid", item: "tee", size: "M", qty: 1, total: 49 });
  await ui.run("checkPayment()");
  assert.equal(ui.requests.at(-1).url, "/api/merch/status?token=status-token");
  assert.equal(ui.element("#payment-title").textContent, "Payment confirmed ✦");
  assert.equal(ui.element("#payment-resume").hidden, true);
});

for (const status of ["paid", "expired", "payment_failed"]) {
  test(`verified ${status} survives reload and a temporary status outage`, async () => {
    const ui = harness();
    await ui.submit();
    ui.reply({ status, item: "tee", size: "L", qty: 2, total: 98 });
    await ui.run("checkPayment()");
    const saved = JSON.parse(ui.storage.get("latamacc-checkout"));
    assert.equal(saved.status, status);
    assert.equal(saved.size, "L");
    assert.equal(saved.total, 98);
    const restored = harness({ persisted: saved });
    restored.run("showPayment()");
    const title = restored.element("#payment-title").textContent;
    assert.doesNotMatch(title, /awaiting payment/);
    assert.equal(restored.element("#payment-resume").hidden, true);
    assert.equal(restored.element("#payment-refresh").hidden, true);
    restored.reply(new Error("Temporarily offline"));
    await restored.run("checkPayment()");
    assert.equal(restored.element("#payment-title").textContent, title);
    assert.equal(restored.element("#payment-resume").hidden, true);
    assert.equal(restored.element("#payment-refresh").disabled, false);
  });
}

test("an unrecognized backend status cannot confirm a payment", async () => {
  const ui = harness();
  await ui.submit();
  ui.reply({ status: "unknown", item: "tee", size: "M", qty: 1, total: 49 });
  await ui.run("checkPayment()");
  assert.equal(JSON.parse(ui.storage.get("latamacc-checkout")).status, "awaiting_payment");
  assert.match(ui.element("#payment-detail").textContent, /Could not verify payment/);
  assert.equal(ui.element("#payment-refresh").hidden, false);
  assert.equal(ui.element("#payment-refresh").disabled, false);
});

test("starting another order removes recovery state and returns focus to email", async () => {
  const ui = harness();
  await ui.submit();
  ui.element("#payment-new").handlers.click();
  assert.equal(ui.storage.has("latamacc-checkout"), false);
  assert.equal(ui.form.hidden, false);
  assert.equal(ui.element("#payment-status").hidden, true);
  assert.equal(ui.form.email.focusCount, 1);
});
