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

// Walks the logically decoded JSON value so escaped characters cannot hide an exact secret.
// Iterative so deeply nested (but size-bounded) JSON cannot exhaust the call stack.
function decodedContains(value, secret) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (current.includes(secret)) return true;
    } else if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
    } else if (current && typeof current === "object") {
      for (const [key, item] of Object.entries(current)) {
        if (key.includes(secret)) return true;
        pending.push(item);
      }
    }
  }
  return false;
}

function discardUpstreamBody(response, reason) {
  // Never block denial on a potentially stalled or hostile upstream stream.
  if (response.body) void response.body.cancel(reason).catch(() => {});
}

async function boundedBody(response, state) {
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
  state.reader = reader;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CONTROL_BODY_BYTES) {
        // Denial must not await cleanup: a misbehaving upstream may never
        // settle cancellation, even after the response byte budget is exceeded.
        void reader.cancel("body_limit").catch(() => {});
        throw new Error("oversized_response");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

const TIMED_OUT = Symbol("control_upstream_timed_out");

// One hard deadline for identity lookup, upstream headers and the bounded body read. It never
// rejects, so the race below cannot leak an unhandled rejection, and an upstream that ignores
// abort is abandoned rather than awaited. Whichever side settles first decides the response.
function controlDeadline(ms) {
  const controller = new AbortController();
  const state = { response: null, reader: null };
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      if (state.reader) void state.reader.cancel("upstream_timeout").catch(() => {});
      else if (state.response) discardUpstreamBody(state.response, "upstream_timeout");
      resolve(TIMED_OUT);
    }, ms);
  });
  return { signal: controller.signal, state, expired, clear: () => clearTimeout(timer) };
}

// Returns either TIMED_OUT, an { status, error } denial, or a { status, body } success.
// It never writes to the browser, so a late result from an abandoned operation has no path out.
async function fetchControlJson({ origin, route, url, appToken, identityToken, deadline }) {
  const idToken = await identityToken();
  if (deadline.signal.aborted) return TIMED_OUT;
  const headers = { Accept: "application/json" };
  if (idToken) {
    headers.Authorization = "Bearer " + idToken;
    headers["X-VelvetOS-Token"] = appToken;
  } else {
    headers.Authorization = "Bearer " + appToken;
  }

  const response = await fetch(origin + route.path + url.search, {
    method: "GET", headers, redirect: "error", signal: deadline.signal,
  });
  deadline.state.response = response;
  if (deadline.signal.aborted) {
    discardUpstreamBody(response, "upstream_timeout");
    return TIMED_OUT;
  }
  if (!response.ok) {
    discardUpstreamBody(response, "upstream_denied");
    const code = response.status === 401 || response.status === 403 ? response.status : 502;
    return { status: code, error: code === 401 || code === 403 ? "control_api_denied" : "upstream_unavailable" };
  }
  if (!jsonType.test(response.headers.get("content-type") || "")) {
    discardUpstreamBody(response, "invalid_content_type");
    return { status: 502, error: "invalid_upstream_content_type" };
  }
  const body = await boundedBody(response, deadline.state);
  let parsed;
  let serialized;
  try {
    // Re-encode the parsed JSON so duplicate object keys or JSON escape sequences
    // cannot preserve credential bytes that were hidden by JSON.parse().
    parsed = JSON.parse(body.toString("utf8"));
    serialized = JSON.stringify(parsed);
  } catch { return { status: 502, error: "invalid_upstream_json" }; }
  // This read-only server-to-server bridge must never reflect either credential
  // into browser JSON, even if a backend erroneously includes one in a 200 body.
  // Check both the serialized text and the decoded strings/keys, since JSON escapes
  // (e.g. \" or \\) hide exact credential bytes from a text-only search.
  // This is an exact-value fence, not a replacement for upstream DTO minimization.
  const secrets = [appToken, idToken].filter(Boolean);
  if (secrets.some((secret) => serialized.includes(secret) || decodedContains(parsed, secret)))
    return { status: 502, error: "control_api_credential_reflection" };
  return { status: 200, body: Buffer.from(serialized, "utf8") };
}

export async function proxyControlRequest({ req, res, url, upstream, appToken, identityToken, writeJson }) {
  const error = (status, name) => writeJson(res, status, { error: name });
  if (req.method !== "GET") return error(405, "method_not_allowed");
  const route = classifyControlRequest(url);
  if (!route.ok) return error(route.status, route.error);
  const origin = validatedOrigin(upstream);
  if (!origin || !appToken) return error(503, "control_api_not_configured");

  const deadline = controlDeadline(CONTROL_REQUEST_TIMEOUT_MS);
  let outcome;
  try {
    outcome = await Promise.race([
      fetchControlJson({ origin, route, url, appToken, identityToken, deadline }),
      deadline.expired,
    ]);
  } finally {
    deadline.clear();
  }
  if (outcome === TIMED_OUT) return error(502, "upstream_unavailable");
  if (outcome.error) return error(outcome.status, outcome.error);

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": outcome.body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(outcome.body);
}
