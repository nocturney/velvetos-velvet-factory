// Bundle canary: rebuild the client with random fake values in every server-side
// env var (and some generic VITE_/CI ones), then fail if any value, or any
// credential marker, appears anywhere in the emitted bundle. Values are synthetic.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

// Every env var the Node server or Vite config reads, plus generic names a future
// client change might accidentally inline (import.meta.env / define).
const CANARY_ENV = [
  "VELVETOS_CONTROL_API_TOKEN",
  "VELVETOS_CONTROL_API_URL",
  "VELVETOS_CONTROL_API_AUDIENCE",
  "VELVETOS_FLEET_API_URL",
  "VELVETOS_FLEET_READONLY_TOKEN",
  "VITE_CONTROL_API_BASE",
  "VITE_VELVETOS_CONTROL_API_TOKEN",
  "VITE_CANARY_SECRET",
  "GITHUB_TOKEN",
];
// Markers that must never ship to the browser regardless of value.
const MARKERS = ["Bearer ", "metadata.google.internal", "VELVETOS_", "X-VelvetOS-Token", "x-velvetos-token"];

function canaryFor(name) {
  const value = "canary-" + randomBytes(16).toString("hex");
  return name.endsWith("_URL") || name.endsWith("_BASE") || name.endsWith("_AUDIENCE")
    ? "https://" + value + ".invalid"
    : value;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// Plain, base64 and URI-encoded forms of each value.
function needles(values) {
  return [...new Set(values.flatMap((v) => [v, Buffer.from(v).toString("base64"), encodeURIComponent(v)]).concat(MARKERS))];
}

export function scanBundle(dir, values) {
  const hits = [];
  const find = needles(values);
  for (const file of walk(dir)) {
    const text = readFileSync(file).toString("latin1");
    for (const needle of find) if (text.includes(needle)) hits.push(relative(dir, file) + " :: " + (values.includes(needle) ? "[canary value]" : needle.startsWith("canary") ? "[encoded canary]" : needle));
  }
  return hits;
}

function build(outDir, env) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(process.execPath, [vite, "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"], {
      cwd: app,
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", reject);
    child.on("exit", (code) => {
      let redacted = stderr;
      for (const v of Object.values(env)) redacted = redacted.replaceAll(v, "[canary]");
      code === 0 ? resolve() : reject(new Error("vite_build_failed " + code + "\n" + redacted));
    });
  });
}

test("bundle never embeds build-time env values or credential markers", { timeout: 120_000 }, async () => {
  const env = Object.fromEntries(CANARY_ENV.map((name) => [name, canaryFor(name)]));
  const values = Object.values(env);
  const outDir = mkdtempSync(join(tmpdir(), "velvetos-bundle-canary-"));
  try {
    await build(outDir, env);
    const files = walk(outDir);
    assert.ok(files.some((f) => f.endsWith("index.html")), "build emitted no index.html");
    assert.ok(files.some((f) => f.endsWith(".js")), "build emitted no JavaScript");

    // Scanner self-check: a planted value and a planted marker must be detected.
    const planted = join(outDir, "__planted_canary__.txt");
    writeFileSync(planted, "x" + values[0] + "x " + MARKERS[0]);
    const selfCheck = scanBundle(outDir, values).filter((hit) => hit.startsWith("__planted_canary__.txt "));
    assert.deepEqual(selfCheck.sort(), [
      "__planted_canary__.txt :: Bearer ",
      "__planted_canary__.txt :: [canary value]",
    ], "scanner failed to detect planted canary");
    rmSync(planted);

    const hits = scanBundle(outDir, values);
    assert.deepEqual(hits, [], "bundle leaked:\n" + hits.join("\n"));
    console.log("PORTAL_SECURITY_PASS bundle_env_canary files=" + files.length + " vars=" + CANARY_ENV.length);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
