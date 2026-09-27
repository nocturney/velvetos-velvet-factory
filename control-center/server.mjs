import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./dist/", import.meta.url));
const port = Number(process.env.PORT || 8080);
const upstream = (process.env.VELVETOS_CONTROL_API_URL || "").replace(/\/$/, "");
const appToken = process.env.VELVETOS_CONTROL_API_TOKEN || "";
const audience = process.env.VELVETOS_CONTROL_API_AUDIENCE || upstream;

const allowedApi = new Set([
  "/v1/snapshot",
  "/v1/capabilities",
]);

function allowedApiPath(pathname) {
  if (allowedApi.has(pathname)) return true;
  return pathname === "/v1/search";
}

async function cloudRunIdentityToken() {
  if (!process.env.K_SERVICE || !audience) return "";
  const url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=" +
    encodeURIComponent(audience) + "&format=full";
  const response = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
  if (!response.ok) throw new Error("identity token unavailable");
  return response.text();
}

async function proxyControl(req, res, url) {
  if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
  if (!upstream || !appToken) return json(res, 503, { error: "control_api_not_configured" });

  const targetPath = url.pathname.replace(/^\/api\/control/, "") || "/";
  if (!allowedApiPath(targetPath)) return json(res, 404, { error: "not_found" });

  const identity = await cloudRunIdentityToken();
  const headers = { Accept: "application/json" };
  if (identity) {
    headers.Authorization = "Bearer " + identity;
    headers["X-VelvetOS-Token"] = appToken;
  } else {
    headers.Authorization = "Bearer " + appToken;
  }

  const response = await fetch(upstream + targetPath + url.search, { headers });
  const body = await response.arrayBuffer();
  res.writeHead(response.status, {
    "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(Buffer.from(body));
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
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
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  let file = join(root, safe);

  try {
    if (!(await stat(file)).isFile()) throw new Error("not file");
  } catch {
    file = join(root, "index.html");
  }

  const body = await readFile(file);
  res.writeHead(200, {
    "Content-Type": mime[extname(file)] || "application/octet-stream",
    "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
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

server.listen(port, "0.0.0.0", () => {
  console.log(`velvetos-control-center listening on :${port}`);
});
