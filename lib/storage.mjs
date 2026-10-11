// Private server-side object storage. Never pass this configuration to the browser.
import { constants, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { S3Client, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const CONFIG_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_S3_BUCKET", "AWS_ACCOUNT_ID", "AWS_IAM_USER", "AWS_SESSION_TOKEN"];
const configurationError = message => new Error(`S3 configuration unavailable: ${message}`);
const hasText = value => typeof value === "string" && value.trim().length > 0 && !/\p{Cc}/u.test(value);

function validateConfig(config) {
  if (!config || typeof config !== "object") throw configurationError("configuration is required.");
  if (!hasText(config.region) || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(config.region))
    throw configurationError("a valid AWS_REGION is required.");
  if (!hasText(config.bucket) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
      config.bucket.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(config.bucket))
    throw configurationError("a valid AWS_S3_BUCKET is required.");
  if (typeof config.accountId !== "string" || !/^\d{12}$/.test(config.accountId))
    throw configurationError("AWS_ACCOUNT_ID must contain 12 digits.");
  if (!hasText(config.credentials?.accessKeyId) || !hasText(config.credentials?.secretAccessKey))
    throw configurationError("both AWS access credentials are required.");
  if (config.credentials.sessionToken !== undefined && !hasText(config.credentials.sessionToken))
    throw configurationError("AWS_SESSION_TOKEN is invalid.");
  if (config.iamUser !== undefined && config.iamUser !== "" && !hasText(config.iamUser))
    throw configurationError("AWS_IAM_USER is invalid.");
  return config;
}

export function loadStorageConfig({ file, env = process.env } = {}) {
  const explicitFile = file !== undefined || env.S3_CONFIG_FILE !== undefined;
  const configFile = file ?? env.S3_CONFIG_FILE ?? join(homedir(), ".config/latamacc/s3.json");
  if (typeof configFile !== "string" || !configFile) throw configurationError("the configuration path is invalid.");
  let saved = {}, descriptor;
  try {
    // Opening without following symlinks and inspecting the open descriptor avoids a path race.
    descriptor = openSync(configFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || (metadata.mode & 0o7777) !== 0o600)
      throw configurationError("the credentials file must be a regular file with permissions 600.");
    try { saved = JSON.parse(readFileSync(descriptor, "utf8")); }
    catch { throw configurationError("the credentials file must contain valid JSON."); }
    if (!saved || typeof saved !== "object" || Array.isArray(saved))
      throw configurationError("the credentials file must contain a JSON object.");
  } catch (error) {
    if (error.code === "ENOENT" && !explicitFile) {
      if (!env.AWS_S3_BUCKET) return null;
    } else if (error.message?.startsWith("S3 configuration unavailable:")) {
      throw error;
    } else {
      throw configurationError("the credentials file could not be opened securely.");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const values = Object.fromEntries(CONFIG_KEYS.map(key => [key, env[key] !== undefined ? env[key] : saved[key]]));
  return validateConfig({
    region: values.AWS_REGION,
    bucket: values.AWS_S3_BUCKET,
    accountId: values.AWS_ACCOUNT_ID,
    iamUser: values.AWS_IAM_USER,
    credentials: {
      accessKeyId: values.AWS_ACCESS_KEY_ID,
      secretAccessKey: values.AWS_SECRET_ACCESS_KEY,
      ...(values.AWS_SESSION_TOKEN !== undefined ? { sessionToken: values.AWS_SESSION_TOKEN } : {}),
    },
  });
}

function validKey(key) {
  if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 1 || Buffer.byteLength(key, "utf8") > 1024 ||
      key.startsWith("/") || key.includes("\\") || /\p{Cc}/u.test(key) || key.split("/").some(part => part === "." || part === ".."))
    throw new Error("S3 object key is invalid.");
  return key;
}

const ERROR_CODES = new Set(["AccessDenied", "NoSuchKey", "NoSuchBucket", "NotFound", "PreconditionFailed", "ConditionalRequestConflict",
  "InvalidAccessKeyId", "SignatureDoesNotMatch", "AuthorizationHeaderMalformed", "PermanentRedirect", "InvalidRequest", "RequestTimeout", "TimeoutError", "AbortError"]);

function storageError(operation, original) {
  const status = original?.$metadata?.httpStatusCode;
  const statusCode = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const error = new Error(`S3 ${operation} failed${statusCode ? ` (HTTP ${statusCode})` : ""}.`);
  error.name = "StorageError";
  error.code = ERROR_CODES.has(original?.name) ? original.name : "StorageUnavailable";
  if (statusCode) error.statusCode = statusCode;
  return error;
}

export class S3Storage {
  #client;
  #bucket;
  #accountId;
  #closed = false;

  constructor(config, { client } = {}) {
    validateConfig(config);
    this.#bucket = config.bucket;
    this.#accountId = config.accountId;
    this.#client = client ?? new S3Client({
      region: config.region,
      credentials: { ...config.credentials },
      maxAttempts: 2,
      ignoreConfiguredEndpointUrls: true,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 20000, socketTimeout: 20000, throwOnRequestTimeout: true },
    });
  }

  async #send(operation, command) {
    if (this.#closed) throw new Error("S3 storage is closed.");
    try { return await this.#client.send(command, { abortSignal: AbortSignal.timeout(30000) }); }
    catch (error) { throw storageError(operation, error); }
  }

  check() {
    return this.#send("bucket check", new HeadBucketCommand({ Bucket: this.#bucket, ExpectedBucketOwner: this.#accountId }));
  }

  put(key, body, { contentType = "application/octet-stream", overwrite = false, contentLength } = {}) {
    if (!hasText(contentType)) throw new Error("S3 content type is invalid.");
    if (typeof overwrite !== "boolean") throw new Error("S3 overwrite option must be a boolean.");
    const bodyLength = Buffer.isBuffer(body) || body instanceof Uint8Array ? body.byteLength :
      typeof body === "string" ? Buffer.byteLength(body, "utf8") : undefined;
    if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 0 ||
        (bodyLength !== undefined && contentLength !== bodyLength))) throw new Error("S3 content length is invalid.");
    const length = contentLength ?? bodyLength;
    return this.#send("upload", new PutObjectCommand({
      Bucket: this.#bucket, Key: validKey(key), Body: body, ContentType: contentType,
      ExpectedBucketOwner: this.#accountId, ServerSideEncryption: "AES256",
      ...(overwrite ? {} : { IfNoneMatch: "*" }),
      ...(length !== undefined ? { ContentLength: length } : {}),
    }));
  }

  get(key) {
    return this.#send("download", new GetObjectCommand({ Bucket: this.#bucket, Key: validKey(key), ExpectedBucketOwner: this.#accountId }));
  }

  remove(key, { versionId } = {}) {
    if (versionId !== undefined && !hasText(versionId)) throw new Error("S3 version ID is invalid.");
    return this.#send("delete", new DeleteObjectCommand({
      Bucket: this.#bucket, Key: validKey(key), ExpectedBucketOwner: this.#accountId,
      ...(versionId !== undefined ? { VersionId: versionId } : {}),
    }));
  }

  close() {
    if (!this.#closed) { this.#closed = true; this.#client.destroy(); }
  }
}
