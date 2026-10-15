import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { proxyControlRequest } from "./control-proxy-boundary.mjs";

const root = fileURLToPath(new URL("./dist/", import.meta.url));
const port = Number(process.env.PORT || 8080);
const bindHost = process.env.HOST || "0.0.0.0";
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
  // No dotfiles, encoded traversal, backslashes or unsupported file extensions.
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
    "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/health") {
      return json(res, 200, {
        service: "velvetos-control-center",
        ready: true,
        controlApiConfigured: Boolean(upstream && appToken),
      });
    }
    if (url.pathname.startsWith("/api/control/")) return await proxyControl(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method_not_allowed" });
    return await staticFile(res, url.pathname);
  } catch {
    return json(res, 502, { error: "upstream_unavailable" });
  }
});

server.listen(port, bindHost, () => {
  console.log(`velvetos-control-center listening on ${bindHost}:${server.address().port}`);
});
