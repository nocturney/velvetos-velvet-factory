import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { projectFleetMachines } from "./fleet-projection.mjs";
import { makeSignedFleetSource } from "./fleet-snapshot-source.mjs";
import { proxyControlRequest } from "./control-proxy-boundary.mjs";
import { createIapGuard } from "./iap-jwt.mjs";

const root = fileURLToPath(new URL("./dist/", import.meta.url));
const port = Number(process.env.PORT || 8080);
const bindHost = process.env.HOST || "0.0.0.0";
// An explicit guard setting must be valid before the listener starts.
const iapGuard = createIapGuard();
const fleetOriginEnv = process.env.VELVETOS_FLEET_API_URL || "";
const fleetReadToken = process.env.VELVETOS_FLEET_READONLY_TOKEN || "";
// Read-only signed snapshot. Its only trust boundary is the IAP guard, so it
// refuses to start unless IAP is enforced.
const signedFleetSource = makeSignedFleetSource(process.env, { bindHost });
if (signedFleetSource && !iapGuard.enabled) throw new Error("signed_fleet_requires_iap");

// Intentionally isolated first integration: loopback-only control plane and
// the existing Fleet read-only viewer role. Remote writes remain blocked.
function localFleetOrigin() {
  if (process.env.VELVETOS_FLEET_LOCAL_READONLY !== "1" ||
      bindHost !== "127.0.0.1" || !fleetReadToken) return "";
  try {
    const u = new URL(fleetOriginEnv);
    if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" ||
        !u.port || u.username || u.password ||
        u.pathname !== "/" || u.search || u.hash) return "";
    return u.origin;
  } catch {
    return "";
  }
}

function isLocalRequest(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
}

const MAX_LOCAL_FLEET_BODY_BYTES = 2 * 1024 * 1024;

// The local viewer is trusted only for transport identity, never for response
// size or type. Consume streamed *bytes* under a hard cap, including when
// Content-Length is omitted or inaccurate.
async function boundedLocalFleetJson(response) {
  const kind = response.headers.get("content-type") || "";
  if (!/^(application\/json|application\/[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(kind))
    throw new Error("fleet_response_not_json");
  const advertised = response.headers.get("content-length");
  if (advertised !== null) {
    const size = Number(advertised);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_LOCAL_FLEET_BODY_BYTES)
      throw new Error("fleet_response_size_invalid");
  }
  if (!response.body) throw new Error("fleet_response_empty");
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_LOCAL_FLEET_BODY_BYTES) {
        await reader.cancel("fleet_response_too_large");
        throw new Error("fleet_response_too_large");
      }
      parts.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(parts, size).toString("utf8"));
}

async function fleetMachines(req, res, url) {
  if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
  if (url.pathname !== "/api/fleet/v1/machines")
    return json(res, 404, { error: "not_found" });
  if (url.search) return json(res, 400, { error: "unexpected_query" });
  if (signedFleetSource) {
    // Verified source only: never fall back to the local viewer bridge if the
    // snapshot is stale, malformed, unsigned, replayed or unreachable.
    try { return json(res, 200, await signedFleetSource()); }
    catch { return json(res, 503, { error: "fleet_snapshot_unavailable" }); }
  }
  if (!isLocalRequest(req)) return json(res, 403, { error: "local_only" });
  const origin = localFleetOrigin();
  if (!origin) return json(res, 503, { error: "fleet_not_configured" });

  const response = await fetch(origin + "/api/machines", {
    method: "GET",
    headers: { Authorization: "Bearer " + fleetReadToken, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return json(res, 502, { error: "fleet_unavailable" });
  return json(res, 200, projectFleetMachines(await boundedLocalFleetJson(response)));
}
const upstream = (process.env.VELVETOS_CONTROL_API_URL || "").replace(/\/$/, "");
const appToken = process.env.VELVETOS_CONTROL_API_TOKEN || "";
const audience = process.env.VELVETOS_CONTROL_API_AUDIENCE || upstream;

async function cloudRunIdentityToken() {
  if (!audience || process.env.VELVETOS_USE_GCP_IDENTITY !== "1") return "";
  const url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=" +
    encodeURIComponent(audience) + "&format=full";
  const response = await fetch(url, {
    headers: { "Metadata-Flavor": "Google" },
    redirect: "error",
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error("identity token unavailable");
  return response.text();
}

async function proxyControl(req, res, url) {
  return proxyControlRequest({
    req, res, url, upstream, appToken,
    identityToken: cloudRunIdentityToken,
    writeJson: json,
  });
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

async function staticFile(res, pathname) {
  let requested;
  try { requested = decodeURIComponent(pathname === "/" ? "index.html" : pathname.slice(1)); }
  catch { return json(res, 404, { error: "not_found" }); }
  if (/(^|[\\/])\./.test(requested) || requested.includes("\\") ||
      requested.includes("..") || /[\x00-\x1f\x7f]/.test(requested))
    return json(res, 404, { error: "not_found" });
  const safe = normalize(requested);
  let file = join(root, safe);
  if (extname(file) && !mime[extname(file)])
    return json(res, 404, { error: "not_found" });

  try {
    if (!(await stat(file)).isFile()) throw new Error("not file");
  } catch {
    if (extname(file)) return json(res, 404, { error: "not_found" });
    file = join(root, "index.html");
  }

  const body = await readFile(file);
  res.writeHead(200, {
    "Content-Type": mime[extname(file)] || "application/octet-stream",
    // Only Vite's content-hashed dist/assets/* are immutable; unhashed root files (index.html,
    // favicon.*) revalidate so an updated file is picked up.
    "Cache-Control": file.startsWith(join(root, "assets") + sep) ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(body);
}

// Cloud Run liveness probes are HTTP-only and do not pass through IAP, so this one
// path is answered before the guard. Exact raw target, GET only, constant body:
// no data, no upstream call, no file read. (Not /healthz: Cloud Run reserves some
// paths ending in "z".) /health stays guarded.
const LIVENESS_PATH = "/liveness";

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === LIVENESS_PATH) return json(res, 200, { ok: true });
    // IAP JWT verifies the request itself, before health, static or token-bearing proxy reads.
    // The current staging config remains backward-compatible until explicit gated enablement.
    if (iapGuard.enabled && !(await iapGuard.verify(req.headers)))
      return json(res, 401, { error: "unauthorized" });
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/health") {
      return json(res, 200, {
        service: "velvetos-control-center",
        ready: true,
        controlApiConfigured: Boolean(upstream && appToken),
      });
    }
    if (url.pathname.startsWith("/api/control/")) return await proxyControl(req, res, url);
    if (url.pathname.startsWith("/api/fleet/")) return await fleetMachines(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method_not_allowed" });
    return await staticFile(res, url.pathname);
  } catch {
    return json(res, 502, { error: "upstream_unavailable" });
  }
});

server.listen(port, bindHost, () => {
  console.log(`velvetos-control-center listening on ${bindHost}:${server.address().port}`);
});
