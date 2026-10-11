import test from "node:test";
import assert from "node:assert/strict";
import { checkEmail, probeEmail } from "../scripts/email.mjs";

const config = { apiKey: "fake-private-key", fromEmail: "danny@latamacc.si", fromName: "LATAMACC", replyToEmail: "danny@latamacc.si", timeoutMs: 1000 };
function provider({ accountEmail = "danny@latamacc.si", authenticated = true, responseStatus = 201 } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    assert.equal(new URL(url).origin, "https://api.brevo.com");
    assert.equal(init.headers["api-key"], config.apiKey);
    assert.equal(init.redirect, "error");
    calls.push({ url, init });
    if (url.endsWith("/account")) return Response.json({ email: accountEmail, relay: { enabled: true }, address: { street: "PRIVATE" }, marketingAutomation: { key: "HIDDEN" }, plan: [{ type: "payAsYouGo", credits: 5000, creditsType: "sendLimit" }] });
    if (url.endsWith("/senders/domains/latamacc.si")) return Response.json({ domain: "latamacc.si", authenticated });
    if (url.endsWith("/senders?domain=latamacc.si")) return Response.json({ senders: [{ email: config.fromEmail, active: true, ips: [] }] });
    if (url.endsWith("/smtp/email")) return Response.json(responseStatus === 201 ? { messageId: "<test@brevo>" } : { error: "private response" }, { status: responseStatus });
    throw new Error("Unexpected provider endpoint");
  };
  return { fetchFn, calls };
}

test("admin check filters private account data and validates independent LATAMACC identity", async () => {
  const p = provider();
  const result = await checkEmail(config, p);
  assert.equal(result.domainAuthenticated, true);
  assert.equal(result.senderActive, true);
  assert.equal(result.sharedIp, true);
  assert.equal(result.plans[0].credits, 5000);
  for (const privateValue of [config.apiKey, "PRIVATE", "HIDDEN"]) assert.ok(!JSON.stringify(result).includes(privateValue));
  const wrong = provider({ accountEmail: "owner@xertify.co" });
  await assert.rejects(probeEmail(config, "owner@example.test", wrong), /independent LATAMACC/);
  assert.equal(wrong.calls.length, 1);
});

test("probe sends one honest synthetic message only after authenticated account checks", async () => {
  const p = provider();
  const result = await probeEmail(config, "owner@example.test", p);
  assert.equal(result.accepted, true);
  const sent = p.calls.filter(call => call.init.method === "POST");
  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.to, [{ email: "owner@example.test", contactPixelTrackingConsent: false }]);
  assert.match(body.textContent, /No registration or order was created/);
  assert.ok(!JSON.stringify(result).includes(config.apiKey));
  const inactive = provider({ authenticated: false });
  await assert.rejects(probeEmail(config, "owner@example.test", inactive), /not ready/);
  assert.ok(!inactive.calls.some(call => call.init.method === "POST"));
});

test("probe does not retry provider failure or send to an invalid recipient", async () => {
  const failed = provider({ responseStatus: 503 });
  const result = await probeEmail(config, "owner@example.test", failed);
  assert.equal(result.accepted, false);
  assert.equal(failed.calls.filter(call => call.init.method === "POST").length, 1);
  assert.ok(!JSON.stringify(result).includes("private response"));
  const invalid = provider();
  await assert.rejects(probeEmail(config, "owner\0@example.test", invalid), /valid explicit recipient/);
  assert.equal(invalid.calls.length, 0);
});
