import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  api,
  buildRequest,
  cancelOperation,
  downloadArtifacts,
  readConfig,
  startModeling,
  storeKey,
  summarize,
  waitForOperation,
} from "../skills/mint-modeler/scripts/mint-modeler.mjs";

const config = { apiKey: "test-key-never-printed", baseUrl: "https://api.mint.gg/v1" };
const noSleep = async () => {};
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

test("reads the key from the environment or the credentials file, and requires HTTPS", () => {
  const dir = mkdtempSync(join(tmpdir(), "mint-modeler-"));
  assert.throws(() => readConfig({ XDG_CONFIG_HOME: dir }), /No Mint API key/);
  const path = storeKey("stored-key", { XDG_CONFIG_HOME: dir });
  assert.equal(readConfig({ XDG_CONFIG_HOME: dir }).apiKey, "stored-key");
  assert.equal(readConfig({ XDG_CONFIG_HOME: dir, MINT_API_KEY: "env-key" }).apiKey, "env-key");
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(
    () => readConfig({ MINT_API_KEY: "k", MINT_API_BASE_URL: "http://api.example.com/v1" }),
    /HTTPS/,
  );
});

test("builds a Modeler request and rejects bad input before spending Credits", () => {
  assert.deepEqual(buildRequest({ prompt: "A mug", tier: "low", referenceImageIds: [] }), {
    prompt: "A mug",
    qualityTier: "low",
  });
  assert.throws(() => buildRequest({ prompt: "A mug", tier: "ultra" }), /quality tier/);
  assert.throws(() => buildRequest({ referenceImageIds: [] }), /description/);
  assert.throws(() => buildRequest({ prompt: "x".repeat(8001) }), /8,000/);
});

test("starts modeling with bearer auth and retries a 503 with the same idempotency key", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1
      ? json({ type: "https://api.mint.gg/problems/generation-start-failed", status: 503 }, 503)
      : json({ id: "op_1", status: "queued", modeler: { stage: "queued" } }, 202);
  };
  const op = await startModeling({ prompt: "A mug", qualityTier: "low" }, { config, fetchImpl, sleep: noSleep });
  assert.equal(op.id, "op_1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.mint.gg/v1/modeler:generate");
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-key-never-printed");
  assert.ok(calls[0].init.headers["Idempotency-Key"]);
  assert.equal(calls[0].init.headers["Idempotency-Key"], calls[1].init.headers["Idempotency-Key"]);
});

test("revisions use the revise route", async () => {
  let seen;
  await startModeling({ prompt: "Thicker handle" }, {
    config,
    parentModelId: "model_1",
    fetchImpl: async (url) => ((seen = url), json({ id: "op_2", status: "queued" }, 202)),
  });
  assert.equal(seen, "https://api.mint.gg/v1/modeler/model_1:revise");
});

test("respects Retry-After on 429 and never retries a mutation without a key", async () => {
  const waits = [];
  let n = 0;
  const { body } = await api("/me", {
    config,
    sleep: async (ms) => waits.push(ms),
    fetchImpl: async () => (++n === 1 ? json({ status: 429 }, 429, { "Retry-After": "2" }) : json({ ok: true })),
  });
  assert.deepEqual(body, { ok: true });
  assert.ok(waits[0] >= 2000);

  let posts = 0;
  await assert.rejects(
    api("/anything", { config, method: "POST", body: {}, sleep: noSleep, fetchImpl: async () => (posts++, json({}, 500)) }),
    /Mint API 500/,
  );
  assert.equal(posts, 1);
});

test("does not retry billing errors and exposes the problem type", async () => {
  let n = 0;
  await assert.rejects(
    startModeling({ prompt: "A mug", qualityTier: "high" }, {
      config,
      sleep: noSleep,
      fetchImpl: async () => (n++, json({ type: "https://api.mint.gg/problems/billing-required", status: 402, title: "Insufficient Credits" }, 402)),
    }),
    (error) => error.status === 402 && error.type === "billing-required",
  );
  assert.equal(n, 1);
});

test("polls until a final status", async () => {
  const stages = ["queued", "modeling", "succeeded"];
  let i = 0;
  const op = await waitForOperation("op_1", {
    config,
    sleep: noSleep,
    fetchImpl: async () => {
      const stage = stages[i++];
      return json({ id: "op_1", status: stage === "succeeded" ? "succeeded" : stage === "queued" ? "queued" : "running", modeler: { stage } });
    },
  });
  assert.equal(op.status, "succeeded");
  assert.equal(i, 3);
});

test("cancels with a stable key", async () => {
  let seen;
  await cancelOperation("op_1", { config, fetchImpl: async (url, init) => ((seen = { url, init }), json({ id: "op_1", status: "canceled" })) });
  assert.equal(seen.url, "https://api.mint.gg/v1/operations/op_1:cancel");
  assert.equal(seen.init.headers["Idempotency-Key"], "cancel-op_1");
});

test("downloads the GLB without sending the API key and summarizes Credits", async () => {
  const out = mkdtempSync(join(tmpdir(), "mint-modeler-out-"));
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(init?.headers ?? {});
    const bytes = url.endsWith(".glb") ? Buffer.from("glTF....") : Buffer.from("png");
    return new Response(bytes, { status: 200 });
  };
  const op = {
    id: "op_1",
    status: "succeeded",
    resource: { type: "model", id: "model_1" },
    modeler: { stage: "succeeded", billingState: "settled", maxCredits: 2000, artifacts: { glb: "https://cdn.example/m.glb", preview: "https://cdn.example/m.png" } },
    credits: { reserved: 0, finalized: 640 },
  };
  const files = await downloadArtifacts(op, out, { fetchImpl });
  assert.equal(readFileSync(files.glb.path).subarray(0, 4).toString(), "glTF");
  assert.ok(sent.every((headers) => !("Authorization" in headers)));
  const summary = summarize(op, files);
  assert.equal(summary.creditsCharged, 640);
  assert.equal(summary.modelId, "model_1");
  assert.equal(summary.glbHeaderOk, true);
  assert.ok(!JSON.stringify(summary).includes("test-key"));
});

test("runs when the skill folder is reached through a symlink", { skip: process.platform === "win32" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const { symlinkSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const scripts = fileURLToPath(new URL("../skills/mint-modeler/scripts", import.meta.url));
  const link = join(mkdtempSync(join(tmpdir(), "mint-modeler-link-")), "scripts");
  symlinkSync(scripts, link, "dir");
  const run = spawnSync(process.execPath, [join(link, "mint-modeler.mjs"), "help"], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Mint Modeler helper/);
});
