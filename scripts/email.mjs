// Local administration only. Never print API credentials or provider response bodies.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { BrevoMailer, loadBrevoConfig } from "../lib/email.mjs";

const API = "https://api.brevo.com/v3";
const EXPECTED_ACCOUNT = "danny@latamacc.si";

async function get(config, path, fetchFn) {
  let response;
  try {
    response = await fetchFn(API + path, {
      headers: { "api-key": config.apiKey, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new Error("Brevo account check unavailable."); }
  if (!response.ok) throw new Error(`Brevo account check failed (HTTP ${response.status}).`);
  try { return await response.json(); }
  catch { throw new Error("Brevo account check returned an invalid response."); }
}

export async function checkEmail(config, { fetchFn = fetch } = {}) {
  if (!config) throw new Error("Brevo is not configured or is disabled.");
  const account = await get(config, "/account", fetchFn);
  if (account.email?.toLowerCase() !== EXPECTED_ACCOUNT)
    throw new Error("The API key does not belong to the independent LATAMACC account.");
  const [domain, senders] = await Promise.all([
    get(config, "/senders/domains/latamacc.si", fetchFn),
    get(config, "/senders?domain=latamacc.si", fetchFn),
  ]);
  const sender = senders.senders?.find(item => item.email?.toLowerCase() === config.fromEmail.toLowerCase());
  return {
    configured: true, accountMatches: true, account: EXPECTED_ACCOUNT,
    domainAuthenticated: domain.domain === "latamacc.si" && domain.authenticated === true,
    sender: config.fromEmail, senderActive: sender?.active === true,
    sharedIp: sender ? Array.isArray(sender.ips) && sender.ips.length === 0 : null,
    relayEnabled: typeof account.relay?.enabled === "boolean" ? account.relay.enabled : null,
    plans: Array.isArray(account.plan) ? account.plan.map(({ type, credits, creditsType }) => ({ type, credits, creditsType })) : [],
  };
}

export async function probeEmail(config, recipient, { fetchFn = fetch } = {}) {
  if (typeof recipient !== "string" || recipient.length > 120 || /\p{Cc}/u.test(recipient) || !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(recipient))
    throw new Error("Provide a valid explicit recipient with --to.");
  const status = await checkEmail(config, { fetchFn });
  if (!status.domainAuthenticated || !status.senderActive || status.relayEnabled === false)
    throw new Error("Brevo domain, sender or transactional relay is not ready.");
  const probeId = randomUUID();
  const result = await new BrevoMailer(config, { fetchFn }).send({
    sender: { name: config.fromName, email: config.fromEmail },
    replyTo: { email: config.replyToEmail },
    to: [{ email: recipient, contactPixelTrackingConsent: false }],
    subject: "LATAMACC transactional email connection test",
    textContent: `This is the requested LATAMACC email integration test. No registration or order was created.\n\nReference: ${probeId}\n\nLATAMACC · https://latamacc.si`,
    htmlContent: `<html lang="en"><body><p>This is the requested LATAMACC email integration test. No registration or order was created.</p><p>Reference: ${probeId}</p><p>LATAMACC · <a href="https://latamacc.si">latamacc.si</a></p></body></html>`,
    tags: ["latamacc-transactional", "integration-test"],
  });
  // No automatic retry: an unknown result must be reconciled in Brevo first.
  return { probeId, accepted: result.status === "sent", status: result.status, messageId: result.messageId, reason: result.reason };
}

async function main(args) {
  const [command, flag, recipient, ...extra] = args;
  if (extra.length || !((command === "check" && !flag) || (command === "probe" && flag === "--to" && recipient)))
    throw new Error("Usage: node scripts/email.mjs check | probe --to recipient@example.com");
  const config = loadBrevoConfig();
  const result = command === "check" ? await checkEmail(config) : await probeEmail(config, recipient);
  console.log(JSON.stringify(result, null, 2));
  if (command === "check" ? !result.domainAuthenticated || !result.senderActive || result.relayEnabled === false : !result.accepted)
    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    // Only our fixed messages are emitted; transport/provider bodies never enter errors.
    console.error(error.message);
    process.exitCode = 1;
  });
}
