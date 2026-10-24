import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { classifyControlRequest, proxyControlRequest } from "./control-proxy-boundary.mjs";

const controlTarget = process.env.VELVETOS_CONTROL_API_URL || "http://127.0.0.1:8080";
const controlToken = process.env.VELVETOS_CONTROL_API_TOKEN || "";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const CONTROL_PREFIX = "/api/control";

function oneHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) return "";
  return typeof value === "string" ? value : null;
}

function loopbackOrigin(hostHeader: string): string {
  let parsed: URL;
  try {
    parsed = new URL(`http://${hostHeader}`);
  } catch {
    return "";
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
  if (!LOOPBACK.has(parsed.hostname)) return "";
  return parsed.origin;
}

// The browser client uses fetch(), which sends Origin and Sec-Fetch-Site: same-origin.
// A foreign Origin cannot be spoofed to match this host, so that is the CSRF boundary.
// The bearer is attached only after this function returns null.
function denyDevProxy(req: IncomingMessage): { status: number; error: string } | null {
  if (req.method !== "GET") return { status: 405, error: "method_not_allowed" };
  const site = oneHeader(req.headers["sec-fetch-site"]);
  if (site === null) return { status: 403, error: "cross_origin_rejected" };
  const normalizedSite = site.toLowerCase();
  if (normalizedSite && normalizedSite !== "same-origin" && normalizedSite !== "none") {
    return { status: 403, error: "cross_origin_rejected" };
  }
  const origin = oneHeader(req.headers.origin);
  const host = oneHeader(req.headers.host);
  if (origin === null || host === null) return { status: 403, error: "cross_origin_rejected" };
  if (origin) {
    const self = loopbackOrigin(host);
    let presented = "";
    try {
      const parsed = new URL(origin);
      if (parsed.origin === origin) presented = parsed.origin;
    } catch { /* fail closed */ }
    if (!self || presented !== self) return { status: 403, error: "cross_origin_rejected" };
  }
  let url: URL;
  try {
    url = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    return { status: 400, error: "invalid_request" };
  }
  const route = classifyControlRequest(url);
  if (!route.ok) return { status: route.status, error: route.error };
  // Fail closed on any non-canonical spelling (../, %2e%2e, backslash, percent-encoded
  // letters). The raw path must be byte-identical to the validated one, so the
  // path that was checked is exactly the path that is forwarded.
  const rawPath = (req.url || "").split("?", 1)[0];
  if (rawPath !== CONTROL_PREFIX + route.path) return { status: 400, error: "non_canonical_path" };
  return null;
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

// Same shared boundary as the production server: the upstream body is re-encoded and
// checked for the server-held token before any byte reaches the browser, and upstream
// errors are mapped to fixed codes rather than echoed. Registered as middleware so it
// runs before Vite's own proxy handling; the Vite proxy is intentionally not used.
function controlMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    const path = (req.url || "").split("?", 1)[0];
    if (path !== CONTROL_PREFIX && !path.startsWith(CONTROL_PREFIX + "/")) return next();
    const denied = denyDevProxy(req);
    if (denied) return writeJson(res, denied.status, { error: denied.error });
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      await proxyControlRequest({
        req,
        res,
        url,
        upstream: controlTarget,
        appToken: controlToken,
        identityToken: async () => "",
        writeJson,
      });
    } catch {
      // Network, timeout, oversize and parse failures all collapse to one sanitized code.
      if (!res.headersSent) writeJson(res, 502, { error: "upstream_unavailable" });
      else res.destroy();
    }
  };
}

function controlProxyPlugin(): Plugin {
  return {
    name: "velvetos-control-proxy",
    configureServer(server) {
      server.middlewares.use(controlMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(controlMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [react(), controlProxyPlugin()],
  server: {
    host: "127.0.0.1",
    port: 4173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});
