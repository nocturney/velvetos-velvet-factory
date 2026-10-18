import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// This test runs in GitHub CI without Docker and verifies the release image
// contains every local ESM import used by the actual Node server.
const root = fileURLToPath(new URL("..", import.meta.url));
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const blocks = dockerfile.split(/^FROM\s+[^\r\n]+/gm).filter(Boolean);
assert.equal(blocks.length, 2, "expected 2-stage release image");

function copySources(stage) {
  const files = new Set();
  for (const line of stage.split(/\r?\n/)) {
    const match = line.trim().match(/^COPY\s+(.+)$/i);
    if (!match) continue;
    const args = match[1].split(/\s+/).filter(Boolean);
    if (args[0]?.startsWith("--from=")) continue;
    for (const item of args.slice(0, -1)) files.add(item.replace(/^\.\//, ""));
  }
  return files;
}
const buildFiles = copySources(blocks[0]);
const runtimeFiles = copySources(blocks[1]);
function includesFile(files, name) {
  return files.has(name) ||
    [...files].some(dir => name.startsWith(dir.replace(/\/$/, "") + "/"));
}

function importsOf(file, visited = new Set()) {
  if (visited.has(file)) return visited;
  visited.add(file);
  const code = readFileSync(resolve(root, file), "utf8");
  const re = /\b(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(code))) {
    const target = resolve(dirname(resolve(root, file)), m[1]);
    if (target.endsWith(".mjs")) {
      const rel = relative(root, target).replaceAll("\\", "/");
      assert(!rel.startsWith("../"), "server import escaped app root");
      importsOf(rel, visited);
    }
  }
  return visited;
}

test("P0 release Dockerfile packages server imports and security smoke", () => {
  const runtimeDeps = importsOf("server.mjs");
  for (const file of runtimeDeps) {
    assert(includesFile(buildFiles, file), "missing build-stage server dependency: " + file);
    assert(includesFile(runtimeFiles, file), "missing runtime-stage server dependency: " + file);
  }
  assert(includesFile(buildFiles, "scripts/security-boundary.node.mjs"),
    "npm run build includes smoke:security; Docker build stage must include its test code");
  assert(includesFile(buildFiles, "index.html"), "frontend HTML missing from build");
  assert(includesFile(buildFiles, "src/App.tsx"), "frontend src missing from build");
  assert(includesFile(buildFiles, "public/favicon.svg") && includesFile(buildFiles, "public/favicon.ico"),
    "public/ (favicon) missing from build; Vite copies it into dist");
  assert(blocks[0].includes("npm run build"), "must run exact CI build contract in container");
  assert(blocks[1].includes("COPY --from=build /app/dist ./dist"), "missing built browser assets");
  assert(blocks[1].includes('CMD ["node", "server.mjs"]'), "unexpected server entrypoint");

  // Base image pinned by digest, same digest in both stages.
  const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
  assert.equal(froms.length, 2);
  for (const ref of froms) assert.match(ref, /^node:24-alpine@sha256:[0-9a-f]{64}$/, "base image must be pinned by digest: " + ref);
  assert.equal(froms[0], froms[1], "build and runtime stages must use the same pinned base");

  // Runtime stage drops root before the server starts, and never switches back.
  const users = [...blocks[1].matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(users, ["node"], "runtime stage must run as USER node");
  assert(blocks[1].indexOf("USER node") < blocks[1].indexOf("CMD "), "USER node must precede CMD");
  assert(!/--chown|--chmod/.test(blocks[1]), "runtime app files stay root-owned and read-only for the node user");
  console.log("PORTAL_IMAGE_CONTRACT_PASS deps=" + runtimeDeps.size + " security_smoke=included");
});
