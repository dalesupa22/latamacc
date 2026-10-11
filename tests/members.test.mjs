import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const pause = ms => new Promise(r => setTimeout(r, ms));
async function eventually(check) {
  const deadline = Date.now() + 8000;
  while (!check()) { if (Date.now() > deadline) assert.fail("Timed out"); await pause(25); }
}

// Servidor aislado: Brevo simulado (sin red), sin S3 ni MoonPay, base temporal.
async function app(t) {
  const dir = mkdtempSync(join(tmpdir(), "latamacc-members-test-"));
  const brevoFile = join(dir, "brevo.json"), mailFile = join(dir, "mail.json"), preload = join(dir, "mock.mjs");
  writeFileSync(brevoFile, JSON.stringify({ apiKey: "fake-brevo-private", minIntervalMs: 1000 }), { mode: 0o600 });
  writeFileSync(preload, `
    import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    const mailFile=${JSON.stringify(mailFile)};
    globalThis.fetch=async (input,options={}) => {
      if(String(input)!=='https://api.brevo.com/v3/smtp/email')throw Error('External requests disabled in tests');
      const mails=existsSync(mailFile)?JSON.parse(readFileSync(mailFile,'utf8')):[];
      mails.push(JSON.parse(options.body));writeFileSync(mailFile,JSON.stringify(mails));
      return Response.json({messageId:'<test-'+mails.length+'>'},{status:201});
    };`);
  const child = spawn(process.execPath, ["--import", preload, "server.mjs"], { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DATA_DIR: dir, BREVO_ENABLED: "1", BREVO_CONFIG_FILE: brevoFile,
      MOONPAY_FILE: join(dir, "no-moonpay"), TURNSTILE_FILE: join(dir, "no-turnstile"), S3_CONFIG_FILE: join(dir, "no-s3") } });
  let output = "", base;
  child.stdout.on("data", d => output += d); child.stderr.on("data", d => output += d);
  await eventually(() => { if (child.exitCode !== null) assert.fail(output); return base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; });
  t.after(async () => { if (child.exitCode === null) { const e = once(child, "exit"); child.kill("SIGTERM"); await e; } rmSync(dir, { recursive: true, force: true }); });
  const ft = () => {
    const ts = Date.now() - 3500, secret = readFileSync(join(dir, "form-secret"), "utf8").trim();
    return `${ts}.${createHmac("sha256", secret).update(String(ts)).digest("hex").slice(0, 32)}`;
  };
  const call = (path, { method = "GET", body, session, raw, type } = {}) => fetch(base + path, { method,
    headers: { ...(session ? { authorization: `Bearer ${session}` } : {}), ...(body || raw ? { "content-type": type || "application/json" } : {}) },
    body: raw ?? (body && JSON.stringify(body)) });
  return { call, ft, output: () => output,
    mails: () => existsSync(mailFile) ? JSON.parse(readFileSync(mailFile, "utf8")) : [],
    rows: sql => { const db = new DatabaseSync(join(dir, "latamacc.db"), { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } } };
}

test("members sign in by email, switch to a company, post and close jobs, and remove their profile", async t => {
  const a = await app(t);
  const email = "ana@example.test";
  assert.equal((await a.call("/api/register", { method: "POST", body: { name: "Ana", email, country: "CO", company: "Old Co", ft: a.ft() } })).status, 201);
  const state = await a.call("/api/state").then(r => r.json());
  assert.equal(state.editing, true);
  assert.equal(state.uploads, false);

  // un correo desconocido recibe la misma respuesta y ningún correo
  const unknown = await a.call("/api/signin/link", { method: "POST", body: { email: "nobody@example.test", ft: a.ft() } });
  assert.equal(unknown.status, 200);
  assert.equal((await a.call("/api/signin/link", { method: "POST", body: { email, ft: a.ft() } })).status, 200);
  await eventually(() => a.mails().length === 2);
  const mail = a.mails().find(m => m.tags.includes("login"));
  assert.equal(mail.to[0].email, email);
  const token = mail.textContent.match(/https:\/\/latamacc\.si\/#signin=([A-Za-z0-9_-]{43})/)[1];
  assert.ok(mail.htmlContent.includes(`href="https://latamacc.si/#signin=${token}"`));
  assert.ok(!a.rows("SELECT hash FROM member_tokens").some(r => r.hash === token), "only hashes are stored");
  await eventually(() => a.rows("SELECT payload FROM email_outbox WHERE event_key LIKE 'login:%'")[0].payload === "{}");

  const signed = await a.call("/api/signin", { method: "POST", body: { token } }).then(r => r.json());
  assert.match(signed.session, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(signed.me.email, email);
  assert.equal((await a.call("/api/signin", { method: "POST", body: { token } })).status, 401, "links work once");
  const session = signed.session;
  assert.equal((await a.call("/api/me")).status, 401);
  assert.equal((await a.call("/api/me", { session: "x".repeat(43) })).status, 401);

  // persona → empresa, con un país adicional
  const edited = await a.call("/api/me", { method: "POST", session, body: { kind: "company", name: "Ana AI", company: "ignored", country: "MX", also: ["CO"], website: "ana.ai", building: "Agents" } });
  assert.equal(edited.status, 200);
  const me = (await edited.json()).me;
  assert.deepEqual([me.kind, me.name, me.company, me.country, me.also, me.website], ["company", "Ana AI", "", "MX", ["CO"], "https://ana.ai/"]);
  assert.equal((await a.call("/api/me", { method: "POST", session, body: { name: "A", country: "MX" } })).status, 400);
  const dirMx = await a.call("/api/directory?country=MX").then(r => r.json());
  assert.deepEqual(dirMx.entries.map(e => [e.name, e.kind]), [["Ana AI", "company"]]);

  // empleos
  assert.equal((await a.call("/api/me/jobs", { method: "POST", session, body: { title: "ML Engineer", workplace: "onsite", type: "full-time", apply: "jobs@ana.ai" } })).status, 400, "on-site needs a country");
  assert.equal((await a.call("/api/me/jobs", { method: "POST", session, body: { title: "ML Engineer", workplace: "remote", type: "nope", apply: "jobs@ana.ai" } })).status, 400);
  const posted = await a.call("/api/me/jobs", { method: "POST", session, body: { title: "ML Engineer", workplace: "remote", type: "full-time", apply: "jobs@ana.ai", description: "Build <agents>" } });
  assert.equal(posted.status, 201);
  const job = (await posted.json()).me.jobs[0];
  assert.equal(job.apply, "mailto:jobs@ana.ai");
  assert.equal(job.company, "Ana AI");
  assert.equal(job.description, "Build agents");
  const list = await a.call("/api/jobs?workplace=remote").then(r => r.json());
  assert.deepEqual(list.jobs.map(j => [j.title, j.poster.name]), [["ML Engineer", "Ana AI"]]);
  assert.equal((await a.call("/api/jobs?workplace=onsite").then(r => r.json())).jobs.length, 0);
  assert.equal((await a.call("/api/directory").then(r => r.json())).entries[0].hiring, 1);
  assert.equal((await a.call("/api/state").then(r => r.json())).jobs, 1);
  assert.equal((await a.call(`/api/me/jobs/${job.id}/close`, { method: "POST", session })).status, 200);
  assert.equal((await a.call("/api/jobs").then(r => r.json())).jobs.length, 0);
  assert.equal((await a.call(`/api/me/jobs/${job.id}/close`, { method: "POST", session })).status, 404);

  // bounties
  const bpost = body => a.call("/api/me/bounties", { method: "POST", session, body });
  assert.equal((await a.call("/api/me/bounties", { method: "POST", body: { title: "Intro", category: "intro", reward: "USD 500", submit: "a@ana.ai" } })).status, 401);
  assert.equal((await bpost({ title: "Intro to a bank CTO", category: "nope", reward: "USD 500", submit: "a@ana.ai" })).status, 400);
  assert.equal((await bpost({ title: "Intro to a bank CTO", category: "intro", reward: "", submit: "a@ana.ai" })).status, 400);
  assert.equal((await bpost({ title: "Intro to a bank CTO", category: "intro", reward: "USD 500", submit: "" })).status, 400);
  assert.equal((await bpost({ title: "Intro to a bank CTO", category: "intro", reward: "USD 500", submit: "a@ana.ai", deadline: "2001-01-01" })).status, 400);
  const day = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
  const bposted = await bpost({ title: "Intro to a bank CTO", category: "intro", reward: "USD 500", submit: "a@ana.ai", deadline: day, description: "Mexico <only>" });
  assert.equal(bposted.status, 201);
  const bounty = (await bposted.json()).me.bounties[0];
  assert.deepEqual([bounty.submit, bounty.description, bounty.reward, bounty.poster.name], ["mailto:a@ana.ai", "Mexico only", "USD 500", "Ana AI"]);
  assert.equal(new Date(bounty.deadline).toISOString().slice(0, 10) >= day, true);
  assert.equal((await bpost({ title: "Launch video", category: "content", reward: "USD 200", submit: "ana.ai/brief" })).status, 201);
  assert.deepEqual((await a.call("/api/bounties?category=intro").then(r => r.json())).bounties.map(x => x.title), ["Intro to a bank CTO"]);
  assert.equal((await a.call("/api/bounties?q=video").then(r => r.json())).bounties[0].submit, "https://ana.ai/brief");
  assert.equal((await a.call("/api/state").then(r => r.json())).bounties, 2);
  assert.equal((await a.call(`/api/me/bounties/${bounty.id}/close`, { method: "POST", session })).status, 200);
  assert.equal((await a.call(`/api/me/bounties/${bounty.id}/close`, { method: "POST", session })).status, 404);
  assert.equal((await a.call("/api/bounties").then(r => r.json())).bounties.length, 1);

  // sin S3 la subida se rechaza con claridad; /media solo sirve claves de avatares
  assert.equal((await a.call("/api/me/avatar", { method: "POST", session, raw: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), type: "image/png" })).status, 503);
  assert.equal((await a.call("/media/../data/latamacc.db")).status, 404);

  // eliminar el perfil borra su sesión y su luz
  assert.equal((await a.call("/api/me", { method: "DELETE", session })).status, 200);
  assert.equal((await a.call("/api/me", { session })).status, 401);
  const after = await a.call("/api/state").then(r => r.json());
  assert.equal(after.total, 0);
  assert.deepEqual(after.byCountry, {});
  assert.equal(a.rows("SELECT COUNT(*) n FROM bounties")[0].n, 0, "a removed profile takes its bounties");
  assert.ok(!a.output().includes("fake-brevo-private"));
});
