// Administrative storage commands. Credentials are read locally, never from CLI arguments.
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { loadStorageConfig, S3Storage } from "../lib/storage.mjs";

const [command = "check", ...args] = process.argv.slice(2);
const usage = "Usage: node scripts/storage.mjs check | probe | put LOCAL_FILE OBJECT_KEY [CONTENT_TYPE] | get OBJECT_KEY NEW_LOCAL_FILE";
let storage;
try {
  if (!({ check: [0], probe: [0], put: [2, 3], get: [2] })[command]?.includes(args.length)) throw Error(usage);
  const config = loadStorageConfig();
  if (!config) throw Error("S3 is not configured.");
  storage = new S3Storage(config);
  if (command === "check") {
    await storage.check();
    console.log(JSON.stringify({ ok: true, bucket: config.bucket, region: config.region }));
  } else if (command === "probe") {
    // Only this synthetic object may be removed, including its exact version when versioning is enabled.
    const key = `_latamacc-checks/${randomUUID()}.txt`;
    const body = Buffer.from(`LATAMACC S3 storage verification ${randomUUID()}\n`);
    let uploaded, cleanedUp = false;
    try {
      uploaded = await storage.put(key, body, { contentType: "text/plain" });
      const object = await storage.get(key);
      const downloaded = Buffer.from(await object.Body.transformToByteArray());
      if (!downloaded.equals(body) || object.ServerSideEncryption !== "AES256") throw Error("S3 verification failed.");
    } catch (error) {
      console.error(`Verification failed for synthetic object ${key}; review this key if the upload result was unknown.`);
      throw error;
    } finally {
      if (uploaded) {
        try { await storage.remove(key, { versionId: uploaded.VersionId }); cleanedUp = true; }
        catch {
          console.error(`S3 verification cleanup failed for ${key}; the synthetic object remains.`);
          process.exitCode = 1;
        }
      }
    }
    console.log(JSON.stringify({ ok: cleanedUp, bucket: config.bucket, region: config.region, write: true, read: true, encryption: "AES256", cleanedUp, ...(!cleanedUp ? { remainingKey: key } : {}) }));
  } else if (command === "put") {
    const [path, key, contentType] = args;
    const source = await stat(path);
    if (!source.isFile()) throw Error("Upload source must be a regular file.");
    const body = createReadStream(path);
    try { await storage.put(key, body, { contentType, contentLength: source.size }); }
    finally { body.destroy(); }
    console.log(JSON.stringify({ ok: true, key }));
  } else if (command === "get") {
    const [key, path] = args;
    const object = await storage.get(key);
    // Do not overwrite an existing local file; downloads are private on disk.
    await pipeline(object.Body, createWriteStream(path, { flags: "wx", mode: 0o600 }));
    console.log(JSON.stringify({ ok: true, key }));
  }
} catch (error) {
  // Library errors are sanitized. Filesystem errors are reduced to their code.
  const message = error.code ? `Storage command failed (${error.code}).` : error.message;
  console.error(message);
  process.exitCode = 1;
} finally {
  storage?.close();
}
