// Trusted, bounded proxy to the canonical Control API. The browser never receives a token.
// Strictly read-only; no credentials survive redirects or unexpected upstream bodies.
export const MAX_CONTROL_BODY_BYTES = 2 * 1024 * 1024;
export const CONTROL_REQUEST_TIMEOUT_MS = 8000;

const ALLOWED_PATHS = new Set(["/v1/snapshot", "/v1/capabilities", "/v1/search"]);
const jsonType = /^(application\/json|application\/[a-z0-9.+-]+\+json)(?:\s*;|$)/i;

export function classifyControlRequest(url) {
  const prefix = "/api/control";
  const path = url.pathname.startsWith(prefix + "/") ? url.pathname.slice(prefix.length) : "";
  if (!ALLOWED_PATHS.has(path)) return { ok: false, status: 404, error: "not_found" };
  if (path === "/v1/search") {
    const params = [...url.searchParams.entries()];
    if (params.length !== 1 || params[0][0] !== "q" ||
        !params[0][1].trim() || params[0][1].length > 200 ||
        /[\x00-\x1f\x7f]/.test(params[0][1])) {
      return { ok: false, status: 400, error: "invalid_search_query" };
    }
  } else if (url.search) {
    return { ok: false, status: 400, error: "unexpected_query" };
  }
  return { ok: true, path };
}

function validatedOrigin(raw) {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash || u.pathname !== "/") return "";
    if (u.protocol === "https:") return u.origin;
    if (u.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname))
      return u.origin;
  } catch { /* intentionally fail closed */ }
  return "";
}

function discardUpstreamBody(response, reason) {
  // Never block denial on a potentially stalled or hostile upstream stream.
  if (response.body) void response.body.cancel(reason).catch(() => {});
}

async function boundedBody(response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const len = Number(declaredLength);
    if (!/^\d+$/.test(declaredLength) || !Number.isSafeInteger(len)) {
      discardUpstreamBody(response, "invalid_content_length");
      throw new Error("invalid_content_length");
    }
    if (len > MAX_CONTROL_BODY_BYTES) {
      discardUpstreamBody(response, "oversized_declared_length");
      throw new Error("oversized_response");
    }
  }
  if (!response.body) throw new Error("missing_body");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CONTROL_BODY_BYTES) {
        await reader.cancel("body_limit");
        throw new Error("oversized_response");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function proxyControlRequest({ req, res, url, upstream, appToken, identityToken, writeJson }) {
  const error = (status, name) => writeJson(res, status, { error: name });
  if (req.method !== "GET") return error(405, "method_not_allowed");
  const route = classifyControlRequest(url);
  if (!route.ok) return error(route.status, route.error);
  const origin = validatedOrigin(upstream);
  if (!origin || !appToken) return error(503, "control_api_not_configured");

  const idToken = await identityToken();
  const headers = { Accept: "application/json" };
  if (idToken) {
    headers.Authorization = "Bearer " + idToken;
    headers["X-VelvetOS-Token"] = appToken;
  } else {
    headers.Authorization = "Bearer " + appToken;
  }

  const response = await fetch(origin + route.path + url.search, {
    method: "GET", headers, redirect: "error",
    signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    discardUpstreamBody(response, "upstream_denied");
    const code = response.status === 401 || response.status === 403 ? response.status : 502;
    return error(code, code === 401 || code === 403 ? "control_api_denied" : "upstream_unavailable");
  }
  if (!jsonType.test(response.headers.get("content-type") || "")) {
    discardUpstreamBody(response, "invalid_content_type");
    return error(502, "invalid_upstream_content_type");
  }
  const body = await boundedBody(response);
  let serialized;
  try {
    // Re-encode the parsed JSON so duplicate object keys or JSON escape sequences
    // cannot preserve credential bytes that were hidden by JSON.parse().
    serialized = JSON.stringify(JSON.parse(body.toString("utf8")));
  } catch { return error(502, "invalid_upstream_json"); }
  // This read-only server-to-server bridge must never reflect either credential
  // into browser JSON, even if a backend erroneously includes one in a 200 body.
  // This is an exact-value fence, not a replacement for upstream DTO minimization.
  if (serialized.includes(appToken) || (idToken && serialized.includes(idToken)))
    return error(502, "control_api_credential_reflection");
  const safeBody = Buffer.from(serialized, "utf8");

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": safeBody.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(safeBody);
}
