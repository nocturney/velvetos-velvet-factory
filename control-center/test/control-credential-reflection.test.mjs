import { afterEach, expect, test } from "vitest";
import { proxyControlRequest } from "../control-proxy-boundary.mjs";

const APP_TOKEN = "local-fixture-app-token-NOT-SECRET-123";
const ID_TOKEN = "local-fixture-identity-token-NOT-SECRET-456";
// Synthetic tokens containing a double quote and a backslash, which JSON.stringify escapes.
const ESCAPE_APP_TOKEN = 'local-fixture-"app"\\token-NOT-SECRET-789';
const ESCAPE_ID_TOKEN = 'local-fixture-"identity"\\token-NOT-SECRET-012';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function proxyFixture(payload, { identity = false, appToken = APP_TOKEN, idToken = ID_TOKEN } = {}) {
  let seen;
  globalThis.fetch = async (_url, options) => {
    expect(options.headers.Authorization).toBe("Bearer " + (identity ? idToken : appToken));
    if (identity) expect(options.headers["X-VelvetOS-Token"]).toBe(appToken);
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    return new Response(text, { headers: { "Content-Type": "application/json" } });
  };
  const res = {
    writeHead(status, headers) { seen = { status, headers }; },
    end(body) { seen.body = body.toString("utf8"); },
  };
  await proxyControlRequest({
    req: { method: "GET" }, res,
    url: new URL("http://localhost/api/control/v1/snapshot"),
    upstream: "https://control.example.test", appToken,
    identityToken: async () => identity ? idToken : "",
    writeJson(_res, status, value) { seen = { status, body: JSON.stringify(value) }; },
  });
  return seen;
}

test("a successful upstream response cannot echo the server's app token", async () => {
  const result = await proxyFixture({ schema: "velvetos.control.v1", flags: { debug: APP_TOKEN } });
  expect(result.status).toBe(502);
  expect(result.body).toBe(JSON.stringify({ error: "control_api_credential_reflection" }));
  expect(result.body).not.toContain(APP_TOKEN);
});

test("a successful upstream response cannot echo the GCP identity token", async () => {
  const result = await proxyFixture({ schema: "velvetos.control.v1", meta: ID_TOKEN }, { identity: true });
  expect(result.status).toBe(502);
  expect(result.body).not.toContain(ID_TOKEN);
});

test("JSON escape sequences cannot hide an echoed credential", async () => {
  const escaped = APP_TOKEN.replace("token-", "tok\\u0065n-");
  const result = await proxyFixture('{"schema":"velvetos.control.v1","meta":"' + escaped + '"}');
  expect(result.status).toBe(502);
  expect(result.body).not.toContain(APP_TOKEN);
});

test("an escape-sensitive app token echoed as a JSON value is rejected", async () => {
  const payload = { schema: "velvetos.control.v1", flags: { debug: ESCAPE_APP_TOKEN } };
  const result = await proxyFixture(payload, { appToken: ESCAPE_APP_TOKEN });
  expect(result.status).toBe(502);
  expect(result.body).toBe(JSON.stringify({ error: "control_api_credential_reflection" }));
  expect(result.body).not.toContain(ESCAPE_APP_TOKEN);
});

test("an escape-sensitive identity token echoed as a JSON object key is rejected", async () => {
  const payload = { schema: "velvetos.control.v1", [ESCAPE_ID_TOKEN]: "ok" };
  const result = await proxyFixture(payload, { identity: true, appToken: ESCAPE_APP_TOKEN, idToken: ESCAPE_ID_TOKEN });
  expect(result.status).toBe(502);
  expect(result.body).toBe(JSON.stringify({ error: "control_api_credential_reflection" }));
  expect(result.body).not.toContain(ESCAPE_ID_TOKEN);
});

test("a safe payload passes when escape-sensitive tokens are configured", async () => {
  const payload = { schema: "velvetos.control.v1", collections: { jobs: { state: "unknown", items: null } } };
  const result = await proxyFixture(payload, { identity: true, appToken: ESCAPE_APP_TOKEN, idToken: ESCAPE_ID_TOKEN });
  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual(payload);
  expect(result.headers["Content-Length"]).toBe(Buffer.byteLength(result.body));
});

test("duplicate JSON keys cannot preserve hidden original bytes in forwarded response", async () => {
  const escaped = APP_TOKEN.replace("token-", "tok\\u0065n-");
  const result = await proxyFixture('{"schema":"velvetos.control.v1","meta":"' + escaped + '","meta":"ok"}');
  expect(result.status).toBe(200);
  expect(result.body).not.toContain(APP_TOKEN);
  expect(result.body).not.toContain(escaped);
  expect(JSON.parse(result.body).meta).toBe("ok");
});

// Nests the leaf inside `depth` arrays; the text is built directly so the fixture itself stays shallow.
function deeplyNestedJson(leaf, depth) {
  return '{"schema":"velvetos.control.v1","deep":' + "[".repeat(depth) + JSON.stringify(leaf) + "]".repeat(depth) + "}";
}

test("deeply nested safe JSON within the body limit still succeeds", async () => {
  const result = await proxyFixture(deeplyNestedJson("safe", 4000));
  expect(result.status).toBe(200);
  expect(result.body).toContain('"safe"');
  expect(result.headers["Content-Length"]).toBe(Buffer.byteLength(result.body));
});

test("a deeply nested escaped credential is rejected without reflection", async () => {
  const result = await proxyFixture(deeplyNestedJson(ESCAPE_APP_TOKEN, 4000), { appToken: ESCAPE_APP_TOKEN });
  expect(result.status).toBe(502);
  expect(result.body).toBe(JSON.stringify({ error: "control_api_credential_reflection" }));
  expect(result.body).not.toContain(ESCAPE_APP_TOKEN);
});

test("canonical non-secret JSON still succeeds with correct length", async () => {
  const payload = { schema: "velvetos.control.v1", collections: { jobs: { state: "unknown", items: null } } };
  const result = await proxyFixture(payload);
  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual(payload);
  expect(result.headers["Content-Length"]).toBe(Buffer.byteLength(result.body));
});
