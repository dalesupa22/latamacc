import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

async function launch(dir) {
  const child = spawn(process.execPath, ["server.mjs"], { cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DATA_DIR: dir, MOONPAY_FILE: join(dir, "no-moonpay"),
      TURNSTILE_FILE: join(dir, "no-turnstile"), S3_CONFIG_FILE: join(dir, "no-s3"), BREVO_ENABLED: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", c => output += c); child.stderr.on("data", c => output += c);
  const deadline = Date.now() + 10_000;
  while (!/latamacc en http/.test(output)) {
    if (child.exitCode !== null || Date.now() > deadline) throw Error(output || "Server did not start");
    await new Promise(r => setTimeout(r, 20));
  }
  const base = output.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[0];
  return { base, stop: async () => { child.kill("SIGTERM"); await once(child, "exit"); } };
}

test("nomads appear in every country they build from, and growth counts members per day", async () => {
  const dir = mkdtempSync(join(tmpdir(), "latamacc-directory-test-"));
  let app;
  try {
    app = await launch(dir);
    const s = await fetch(app.base + "/api/state").then(r => r.json());
    await new Promise(r => setTimeout(r, 3050));
    const post = body => fetch(app.base + "/api/register", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "person", name: "Nomad", email: "nomad@example.test", country: "CO", ft: s.ft, ...body }) });
    // duplicados, el país principal, códigos inválidos y más de 4 se descartan
    const r = await post({ also: ["MX", "MX", "CO", "ZZ", "AR", "BR", "CL", "PE"] });
    assert.equal(r.status, 201);
    assert.deepEqual((await r.json()).builder.also, ["MX", "AR", "BR", "CL"]);
    assert.equal((await post({ name: "Local", email: "local@example.test", also: "nope" })).status, 201);

    const mx = await fetch(app.base + "/api/directory?country=MX").then(r => r.json());
    assert.deepEqual(mx.entries.map(e => e.name), ["Nomad"]);
    const co = await fetch(app.base + "/api/directory?country=CO").then(r => r.json());
    assert.equal(co.entries.length, 2);

    const after = await fetch(app.base + "/api/state").then(r => r.json());
    assert.equal(after.total, 2);
    assert.deepEqual(after.byCountry, { CO: 2, MX: 1, AR: 1, BR: 1, CL: 1 });
    assert.equal(after.growth.reduce((n, [, c]) => n + c, 0), 2);
    assert.deepEqual(after.kinds, { person: 2 });
    assert.match(after.growth[0][0], /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(after.points.find(p => p.name === "Nomad").also, ["MX", "AR", "BR", "CL"]);
    assert.ok(!JSON.stringify(after).includes("@example.test"));
  } finally { if (app) await app.stop(); rmSync(dir, { recursive: true }); }
});
