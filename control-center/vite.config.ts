import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { classifyControlRequest } from "./control-proxy-boundary.mjs";

const controlTarget = process.env.VELVETOS_CONTROL_API_URL || "http://127.0.0.1:8080";
const controlToken = process.env.VELVETOS_CONTROL_API_TOKEN || "";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const CONTROL_PREFIX = "/api/control";
// Never routable upstream; only reachable if bypass was somehow skipped, and it gets no bearer.
const DENIED_UPSTREAM_PATH = "/__velvetos_dev_proxy_denied__";

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

// Build the upstream path only from the validated route, like server.mjs does.
// Returns null when the request is not an allowlisted read.
function validatedUpstreamPath(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl || "/", "http://127.0.0.1");
  } catch {
    return null;
  }
  const route = classifyControlRequest(url);
  if (!route.ok) return null;
  if (rawUrl.split("?", 1)[0] !== CONTROL_PREFIX + route.path) return null;
  return route.path + url.search;
}

function isAllowlistedUpstreamPath(path: string): boolean {
  let url: URL;
  try {
    url = new URL(CONTROL_PREFIX + path, "http://127.0.0.1");
  } catch {
    return false;
  }
  const route = classifyControlRequest(url);
  return route.ok && route.path + url.search === path;
}

function rejectDevProxy(res: ServerResponse, status: number, error: string): string {
  const body = JSON.stringify({ error });
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
  // Vite proxies unless bypass returns a string and the response is already finished.
  return "/";
}

function controlProxy(): ProxyOptions {
  return {
    target: controlTarget,
    changeOrigin: false,
    rewrite: (path) => validatedUpstreamPath(path) ?? DENIED_UPSTREAM_PATH,
    bypass(req, res) {
      const denied = denyDevProxy(req);
      if (!denied || !res) return;
      return rejectDevProxy(res, denied.status, denied.error);
    },
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq) => {
        proxyReq.removeHeader("authorization");
        proxyReq.removeHeader("x-velvetos-token");
        // Defense in depth: the bearer goes only to an allowlisted upstream path.
        if (proxyReq.method !== "GET" || !isAllowlistedUpstreamPath(proxyReq.path)) {
          proxyReq.destroy(new Error("dev_proxy_denied_upstream_path"));
          return;
        }
        if (controlToken) proxyReq.setHeader("Authorization", `Bearer ${controlToken}`);
      });
    },
  };
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: { "/api/control": controlProxy() },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    proxy: { "/api/control": controlProxy() },
  },
});
