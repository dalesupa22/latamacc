// Inspect/stage first; --apply creates a merchant paylink + scoped webhook. No payments are made.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, statSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_FILE, MoonpayCommerce, USD_ID, USDC_SOL_ID } from "../lib/moonpay.mjs";

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? "" : args[i + 1] || ""; };
const file = option("--config") || CONFIG_FILE;
const apply = args.includes("--apply");
const walletId = option("--wallet-id"), publicKey = option("--wallet-public-key");
if (!walletId || !publicKey) {
  console.error("Usage: node scripts/configure-moonpay.mjs --wallet-id ID --wallet-public-key ADDRESS [--config PATH] [--apply]");
  console.error("Select the supported MAIN Solana wallet explicitly; no default wallet is selected.");
  process.exit(1);
}

function save(config) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.moonpay-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

try {
  if (statSync(file).mode & 0o077) throw new Error("Credentials file must have permissions 600.");
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (!config.apiKey || !config.apiSecret) throw new Error("Store the public API key and secret in the external configuration first.");
  if (config.environment && config.environment !== "mainnet") throw new Error("Use mainnet merchant credentials.");
  if (config.pendingOperation) throw new Error(`Previous ${config.pendingOperation} has an unknown outcome. Reconcile in the merchant dashboard before retrying.`);
  const api = new MoonpayCommerce(config);
  const [wallets, currencies] = await Promise.all([api.request("/wallet/all"), fetch("https://api.hel.io/v1/currency").then(r => {
    if (!r.ok) throw new Error("Currency lookup unavailable."); return r.json();
  })]);
  const wallet = wallets.find(w => w.id === walletId && w.publicKey === publicKey);
  if (!wallet || wallet.blockchainEngineType !== "SOL" || (wallet.walletCategory && !["CONNECTED", "PAYOUT"].includes(wallet.walletCategory)))
    throw new Error("The explicit merchant wallet is missing or is not a supported Solana wallet. Do not select a legacy wallet.");
  const usd = currencies.find(c => c.id === USD_ID && c.decimals === 6);
  const usdc = currencies.find(c => c.id === USDC_SOL_ID && c.blockchain?.engine?.type === "SOL" && c.features.includes("PAYMENT_RECIPIENT"));
  if (!usd || !usdc) throw new Error("Configured pricing/payout currencies no longer match the provider.");
  const paylink = {
    template: "OTHER", name: "Latam/acc Golden Era Tee", description: "Golden Era Tee preorder — shipping confirmed separately.",
    dynamic: true, price: "49000000", pricingCurrency: USD_ID,
    features: { canChangeQuantity: false, canChangePrice: false, canSwapTokens: true,
      canPayWithCard: config.canPayWithCard === true, requireEmail: true, requireFullName: true,
      requireCountry: true, requireDeliveryAddress: true, shouldRedirectOnSuccess: true, showDetailsForCharge: true },
    recipients: [{ walletId: wallet.id, currencyId: usdc.id }],
    redirectUrl: "https://latamacc.si/?merch=return#merch", cancelRedirectUrl: "https://latamacc.si/?merch=return#merch",
  };
  const webhook = { events: ["CREATED"], targetUrl: "https://latamacc.si/api/moonpay/webhook" };
  const stageFile = join(dirname(file), "moonpay-plan.json");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(stageFile, JSON.stringify({ paylink, webhook }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(stageFile, 0o600);
  console.log(`Validated explicit ${wallet.walletCategory || "merchant"} wallet; staged paylink/webhook payloads in ${stageFile}.`);
  if (!apply) { console.log("No provider configuration changed. Review the payloads, then repeat with --apply."); process.exit(0); }
  if (config.recipients && JSON.stringify(config.recipients) !== JSON.stringify([{ walletId: wallet.id, currencyId: usdc.id, publicKey: wallet.publicKey }]))
    throw new Error("Existing payout configuration differs. Review before changing a merchant recipient.");
  config.enabled = false;
  config.environment = "mainnet";
  config.pricingCurrencyId = USD_ID;
  config.pricingDecimals = 6;
  config.recipients = [{ walletId: wallet.id, currencyId: usdc.id, publicKey: wallet.publicKey }];
  save(config);
  if (!config.paylinkId) {
    config.pendingOperation = "paylink-create";
    save(config);
    const response = await api.request("/paylink/create/api-key", paylink);
    if (!response.id) throw new Error("Provider did not return a paylink ID.");
    config.paylinkId = response.id;
    delete config.pendingOperation;
    save(config);
  }
  if (!config.webhookToken) {
    config.pendingOperation = "webhook-create";
    save(config);
    const response = await api.request("/webhook/paylink/transaction", { ...webhook, paylinkId: config.paylinkId });
    if (!response.id || !response.sharedToken) throw new Error("Provider did not return webhook credentials.");
    config.webhookId = response.id;
    config.webhookToken = response.sharedToken;
    delete config.pendingOperation;
    save(config);
  }
  if (!config.webhookId) throw new Error("Saved webhook ID is missing. Reconcile the existing webhook in the dashboard.");
  // Repeat readback on recovery as well: saved IDs alone do not prove readiness.
  const [savedPaylink, savedWebhook] = await Promise.all([
    api.request(`/paylink/${encodeURIComponent(config.paylinkId)}`, undefined, { origin: "https://latamacc.si" }),
    api.request(`/webhook/paylink/transaction/${encodeURIComponent(config.webhookId)}`),
  ]);
  if (savedPaylink.id !== config.paylinkId || savedPaylink.dynamic !== true || savedPaylink.pricingCurrency?.id !== USD_ID ||
      savedPaylink.features?.canChangePrice !== false || savedPaylink.features?.canChangeQuantity !== false ||
      savedPaylink.disabled || savedPaylink.inactive || savedPaylink.recipients?.length !== 1 || !savedPaylink.recipients?.some(r =>
        r.wallet?.id === wallet.id && r.wallet?.publicKey === wallet.publicKey && r.currency?.id === usdc.id))
    throw new Error("Provider paylink readback does not match the reviewed merchant configuration. Checkout remains disabled.");
  if (savedWebhook.id !== config.webhookId || savedWebhook.paylink !== config.paylinkId ||
      savedWebhook.targetUrl !== webhook.targetUrl || savedWebhook.inactive || !savedWebhook.events?.includes("CREATED"))
    throw new Error("Provider webhook readback does not match the reviewed configuration. Checkout remains disabled.");
  config.enabled = true;
  save(config);
  console.log("MoonPay merchant configuration saved securely. Restart the Node server to activate checkout.");
} catch (e) {
  console.error(e instanceof SyntaxError ? "Invalid merchant configuration JSON." : e.message);
  process.exitCode = 1;
}
