#!/usr/bin/env node
// Mint Modeler command-line helper. Node 18+ and no dependencies.
// It calls only the Mint API (https://api.mint.gg/v1) with the key from MINT_API_KEY
// or the user's Mint credentials file, and downloads delivered files over HTTPS.
// It never prints the API key.

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BASE_URL = "https://api.mint.gg/v1";
export const QUALITY_TIERS = {
  low: { maxCredits: 2_000, minutes: 30 },
  medium: { maxCredits: 8_000, minutes: 45 },
  high: { maxCredits: 25_000, minutes: 75 },
  studio: { maxCredits: 100_000, minutes: 90 },
};
const TERMINAL = new Set(["succeeded", "failed", "canceled"]);
const IMAGE_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
const MAX_ATTEMPTS = 5;

// ---------- configuration ----------

export function credentialsPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "mint", "credentials");
}

export function readStoredKey(path) {
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*MINT_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
    if (match) return match[1].replace(/^["']|["']$/g, "");
  }
  return undefined;
}

export function readConfig(env = process.env) {
  const apiKey = env.MINT_API_KEY?.trim() || readStoredKey(credentialsPath(env));
  if (!apiKey) {
    throw new UsageError(
      "No Mint API key found. Set MINT_API_KEY or run: node mint-modeler.mjs login. Create a key at https://platform.mint.gg (API keys).",
    );
  }
  const baseUrl = (env.MINT_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
  if (new URL(baseUrl).protocol !== "https:") {
    throw new UsageError("MINT_API_BASE_URL must use HTTPS.");
  }
  return { apiKey, baseUrl };
}

export function storeKey(apiKey, env = process.env) {
  const path = credentialsPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, "MINT_API_KEY=" + apiKey + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows keeps the file inside the user's profile; chmod is not supported there.
  }
  return path;
}

// ---------- HTTP ----------

export class UsageError extends Error {}

export class MintApiError extends Error {
  constructor(status, problem, headers) {
    const detail = problem?.detail || problem?.title || "HTTP " + status;
    super("Mint API " + status + ": " + detail);
    this.status = status;
    this.type = problemType(problem?.type);
    this.problem = problem;
    this.requestId = headers?.get("x-request-id") ?? undefined;
    this.retryAfter = headers?.get("retry-after") ?? undefined;
  }
}

/** Problem types are URLs such as https://api.mint.gg/problems/billing-required. */
export function problemType(typeUrl) {
  if (typeof typeUrl !== "string") return undefined;
  return typeUrl.slice(typeUrl.lastIndexOf("/") + 1) || undefined;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(attempt, retryAfter) {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 120) * 1000 + 250;
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

/**
 * One Mint API call with bounded retries. Reads retry on network errors, 429 and 5xx.
 * Mutations retry only when they carry an Idempotency-Key, so a retry can never start a
 * second paid request.
 */
export async function api(path, opts = {}) {
  const config = opts.config ?? readConfig(opts.env);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const method = opts.method ?? "GET";
  const retrySafe = method === "GET" || Boolean(opts.idempotencyKey);
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetchImpl(config.baseUrl + path, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + config.apiKey,
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (error) {
      if (retrySafe && attempt + 1 < MAX_ATTEMPTS) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      throw error;
    }
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { detail: text.slice(0, 300) };
      }
    }
    if (response.ok) return { body, headers: response.headers };
    const error = new MintApiError(response.status, body, response.headers);
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && retrySafe && attempt + 1 < MAX_ATTEMPTS) {
      await sleep(retryDelayMs(attempt, error.retryAfter));
      continue;
    }
    throw error;
  }
}

// ---------- Modeler ----------

export async function uploadReferenceImage(source, opts = {}) {
  let body;
  if (/^https:\/\//i.test(source)) {
    body = { sourceUrl: source };
  } else {
    const path = resolve(source);
    const contentType = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!contentType) throw new UsageError("Unsupported image type: " + basename(path) + ". Use JPEG, PNG, GIF, or WebP.");
    const size = statSync(path).size;
    if (size > MAX_IMAGE_BYTES) throw new UsageError(basename(path) + " is larger than 5 MB.");
    body = {
      base64Data: readFileSync(path).toString("base64"),
      fileName: basename(path).slice(0, 160),
      contentType,
    };
  }
  const { body: asset } = await api("/reference-images", {
    ...opts,
    method: "POST",
    body,
    idempotencyKey: "ref-" + randomUUID(),
  });
  return asset;
}

export function buildRequest({ prompt, tier, referenceImageIds, conversationId }) {
  if (tier && !QUALITY_TIERS[tier]) {
    throw new UsageError("Unknown quality tier \"" + tier + "\". Use low, medium, high, or studio.");
  }
  if (!prompt && !referenceImageIds?.length) {
    throw new UsageError("Give a description (--prompt), at least one reference image, or both.");
  }
  if (prompt && prompt.length > 8000) throw new UsageError("The description is longer than 8,000 characters.");
  if (referenceImageIds?.length > 8) throw new UsageError("Use at most 8 reference images.");
  return {
    ...(prompt ? { prompt } : {}),
    ...(referenceImageIds?.length ? { referenceImageIds } : {}),
    ...(tier ? { qualityTier: tier } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

export async function startModeling(request, { parentModelId, idempotencyKey, ...opts } = {}) {
  const path = parentModelId
    ? "/modeler/" + encodeURIComponent(parentModelId) + ":revise"
    : "/modeler:generate";
  const { body } = await api(path, {
    ...opts,
    method: "POST",
    body: request,
    idempotencyKey: idempotencyKey ?? "modeler-" + randomUUID(),
  });
  return body;
}

export async function getOperation(operationId, opts = {}) {
  assertId(operationId, "operation");
  return (await api("/operations/" + encodeURIComponent(operationId), opts)).body;
}

export async function cancelOperation(operationId, opts = {}) {
  assertId(operationId, "operation");
  return (
    await api("/operations/" + encodeURIComponent(operationId) + ":cancel", {
      ...opts,
      method: "POST",
      idempotencyKey: "cancel-" + operationId,
    })
  ).body;
}

/** Poll until the operation is final. Modeler work takes minutes, so waits grow from 5 s to 30 s. */
export async function waitForOperation(operationId, opts = {}) {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const timeoutMs = (opts.timeoutMinutes ?? 120) * 60_000;
  const started = now();
  let delay = 5_000;
  let lastStage;
  for (;;) {
    const op = await getOperation(operationId, opts);
    const stage = op?.modeler?.stage ?? op?.status;
    if (stage !== lastStage) {
      opts.onStage?.(stage, op);
      lastStage = stage;
    }
    if (TERMINAL.has(op?.status)) return op;
    if (now() - started >= timeoutMs) {
      const error = new UsageError(
        "Stopped waiting after " + (opts.timeoutMinutes ?? 120) + " minutes; the request is still " + stage +
          ". Resume with: wait " + operationId + "  or cancel with: cancel " + operationId,
      );
      error.operation = op;
      throw error;
    }
    await sleep(delay);
    delay = Math.min(30_000, Math.ceil(delay * 1.6));
  }
}

/** After delivery, billing can stay pending for a short time. Wait briefly so the summary shows the charge. */
export async function waitForSettlement(op, opts = {}) {
  const sleep = opts.sleep ?? defaultSleep;
  let current = op;
  for (let i = 0; i < (opts.checks ?? 8) && current?.modeler?.billingState === "pending"; i++) {
    await sleep(15_000);
    current = await getOperation(op.id, opts);
  }
  return current;
}

export async function download(url, destination, opts = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new UsageError("Refusing a non-HTTPS download URL.");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  // Delivered files are public CDN links: never send the API key with them.
  const response = await fetchImpl(parsed.href, { headers: { Accept: "*/*" } });
  if (!response.ok) throw new Error("Download failed with HTTP " + response.status + ".");
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error("Download is larger than expected; stopped.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("Download is larger than expected; stopped.");
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  return { path: destination, bytes: bytes.length };
}

export async function downloadArtifacts(op, outDir, opts = {}) {
  const artifacts = op?.modeler?.artifacts ?? {};
  const id = safeName(op?.resource?.id ?? op?.id ?? "model");
  const files = {};
  if (artifacts.glb) files.glb = await download(artifacts.glb, join(outDir, id + ".glb"), opts);
  if (artifacts.preview) {
    try {
      files.preview = await download(artifacts.preview, join(outDir, id + ".png"), opts);
    } catch {
      // A missing preview never blocks the model.
    }
  }
  if (files.glb) {
    const magic = readFileSync(files.glb.path).subarray(0, 4).toString("latin1");
    files.glb.validGlbHeader = magic === "glTF";
  }
  return files;
}

export function summarize(op, files) {
  const credits = op?.credits ?? {};
  return {
    operationId: op?.id,
    status: op?.status,
    stage: op?.modeler?.stage,
    type: op?.type,
    modelId: op?.resource?.id ?? null,
    parentModelId: op?.modeler?.parentModelId ?? null,
    billing: op?.modeler?.billingState,
    creditsCharged: credits.finalized ?? null,
    creditsReserved: credits.reserved ?? null,
    creditsMax: op?.modeler?.maxCredits ?? null,
    creditsAvailableAfter: credits.availableAfterReservation ?? null,
    error: op?.error?.message ?? op?.error ?? undefined,
    files: files
      ? Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.path]))
      : undefined,
    glbHeaderOk: files?.glb ? files.glb.validGlbHeader : undefined,
  };
}

function assertId(value, label) {
  if (!value || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new UsageError("A valid " + label + " ID is required.");
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "model";
}

// ---------- CLI ----------

const HELP = [
  "Mint Modeler helper",
  "",
  "Usage: node mint-modeler.mjs <command> [options]",
  "",
  "  login [--stdin]          Save your Mint API key (hidden prompt, or read from stdin)",
  "  me                       Check the key: account, key prefix and available Credits",
  "  generate --prompt TEXT   Create a model. Options:",
  "      --tier low|medium|high|studio   (default high; Low is fastest and cheapest)",
  "      --image PATH_OR_HTTPS_URL       reference image, repeatable (max 8)",
  "      --ref REFERENCE_IMAGE_ID        already-uploaded reference image, repeatable",
  "      --session CONVERSATION_ID       keep the request in a Modeler session",
  "      --out DIR                       where to save the GLB and preview (default ./mint-models)",
  "      --no-wait                       return the operation right away",
  "      --timeout-minutes N             stop waiting after N minutes (default 120)",
  "      --idempotency-key KEY           reuse a key only to retry the same request",
  "  revise MODEL_ID --prompt TEXT   Change a delivered model; same options as generate",
  "  status OPERATION_ID      Show progress and Credits",
  "  wait OPERATION_ID        Wait for a request and download its files (--out, --timeout-minutes)",
  "  cancel OPERATION_ID      Cancel a request (charges only usage already incurred)",
  "  upload PATH_OR_HTTPS_URL Upload a reference image and print its ID",
  "",
].join("\n");

export function parseArgs(argv) {
  const args = { _: [], image: [], ref: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const [flag, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (["no-wait", "stdin", "help"].includes(flag)) {
      args[flag] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new UsageError("--" + flag + " needs a value.");
    if (flag === "image" || flag === "ref") args[flag].push(value);
    else args[flag] = value;
  }
  return args;
}

async function readSecret(useStdin) {
  if (useStdin || !process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stderr.write("Paste your Mint API key (input is hidden), then press Enter: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolveKey, reject) => {
    let value = "";
    process.stdin.on("data", (data) => {
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stderr.write("\n");
          resolveKey(value.trim());
          return;
        }
        if (ch === "\u0003") {
          process.stdin.setRawMode(false);
          reject(new UsageError("Canceled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    });
  });
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function progress(message) {
  process.stderr.write((new Date().toLocaleTimeString()) + " " + message + "\n");
}

async function runModeling(args, parentModelId) {
  const tier = args.tier?.toLowerCase();
  const referenceImageIds = [...args.ref];
  for (const image of args.image) {
    const asset = await uploadReferenceImage(image);
    progress("Uploaded reference image " + asset?.id);
    referenceImageIds.push(asset.id);
  }
  const request = buildRequest({
    prompt: args.prompt?.trim(),
    tier,
    referenceImageIds,
    conversationId: args.session,
  });
  const idempotencyKey = args["idempotency-key"] ?? "modeler-" + randomUUID();
  const op = await startModeling(request, { parentModelId, idempotencyKey });
  const tierName = tier ?? "high";
  progress(
    "Started " + op.id + " (" + tierName + "; reserves up to " + QUALITY_TIERS[tierName].maxCredits.toLocaleString("en-US") + " Credits, charged by usage; modeling time up to " + QUALITY_TIERS[tierName].minutes + " min after it leaves the queue)",
  );
  if (args["no-wait"]) return print(summarize(op));
  return finish(op.id, args);
}

async function finish(operationId, args) {
  let op;
  try {
    op = await waitForOperation(operationId, {
      timeoutMinutes: args["timeout-minutes"] ? Number(args["timeout-minutes"]) : undefined,
      onStage: (stage) => progress(operationId + ": " + stage),
    });
  } catch (error) {
    if (!error.operation) throw error;
    print({
      ...summarize(error.operation),
      stillRunning: true,
      next: "Run: wait " + operationId + " (or cancel " + operationId + ")",
    });
    process.exitCode = 3;
    return;
  }
  let files;
  if (op.status === "succeeded") {
    files = await downloadArtifacts(op, resolve(args.out ?? "mint-models"));
    op = await waitForSettlement(op, { checks: 4 });
  }
  print(summarize(op, files));
  if (op.status !== "succeeded") process.exitCode = 2;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [command, target] = args._;
  if (!command || args.help || command === "help") return console.log(HELP);
  switch (command) {
    case "login": {
      const key = await readSecret(args.stdin);
      if (!key) throw new UsageError("No key received.");
      const { body } = await api("/me", { config: { apiKey: key, baseUrl: readBaseUrl() } });
      const path = storeKey(key);
      return print({ saved: true, credentialsFile: path, owner: body?.owner?.email ?? null, keyPrefix: body?.apiKey?.publicPrefix ?? null });
    }
    case "me": {
      const [{ body: me }, { body: usage }] = await Promise.all([api("/me"), api("/usage")]);
      return print({
        connected: true,
        owner: me?.owner?.email ?? null,
        keyName: me?.apiKey?.name ?? null,
        keyPrefix: me?.apiKey?.publicPrefix ?? null,
        creditsAvailable: usage?.credits?.totalAvailable ?? null,
        creditsReserved: usage?.credits?.totalReserved ?? null,
      });
    }
    case "generate":
      return runModeling(args);
    case "revise":
      assertId(target, "model");
      return runModeling(args, target);
    case "status": {
      const op = await getOperation(target);
      return print({ ...summarize(op), glbUrl: op?.modeler?.artifacts?.glb ?? null });
    }
    case "wait":
      assertId(target, "operation");
      return finish(target, args);
    case "cancel":
      return print(summarize(await cancelOperation(target)));
    case "upload": {
      if (!target) throw new UsageError("Give an image path or HTTPS URL.");
      const asset = await uploadReferenceImage(target);
      return print({ referenceImageId: asset?.id, name: asset?.name ?? null });
    }
    default:
      throw new UsageError("Unknown command \"" + command + "\".\n\n" + HELP);
  }
}

function readBaseUrl() {
  const baseUrl = (process.env.MINT_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
  if (new URL(baseUrl).protocol !== "https:") throw new UsageError("MINT_API_BASE_URL must use HTTPS.");
  return baseUrl;
}

// Compare real paths: skill installers often symlink the skill folder into each agent's folder.
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
const isMain = isEntryPoint();
if (isMain) {
  main().catch((error) => {
    if (error instanceof MintApiError) {
      print({
        error: error.message,
        status: error.status,
        type: error.type ?? null,
        requestId: error.requestId ?? null,
        retryAfterSeconds: error.retryAfter ?? null,
        fields: Array.isArray(error.problem?.errors) ? error.problem.errors : undefined,
      });
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  });
}
