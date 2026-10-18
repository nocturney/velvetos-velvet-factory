import { afterEach, expect, test } from "vitest";
import { MAX_CONTROL_BODY_BYTES, proxyControlRequest } from "../control-proxy-boundary.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function streamedResponse(status, headers) {
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":true}'));
    },
    cancel() { canceled = true; },
  });
  return { response: new Response(body, { status, headers }), wasCanceled: () => canceled };
}

async function proxyFixture(response) {
  const seen = { status: null, headers: null, data: null, json: null };
  const res = {
    writeHead(status, headers) { seen.status = status; seen.headers = headers; },
    end(data) { seen.data = data; },
  };
  globalThis.fetch = async (_url, options) => {
    expect(options.method).toBe("GET");
    expect(options.redirect).toBe("error");
    expect(options.headers.Authorization).toBe("Bearer fixture-only");
    return response;
  };
  await proxyControlRequest({
    req: { method: "GET" }, res,
    url: new URL("http://127.0.0.1/api/control/v1/snapshot"),
    upstream: "https://control.example.test",
    appToken: "fixture-only", identityToken: async () => "",
    writeJson(output, status, payload) {
      seen.status = status;
      seen.json = payload;
    },
  });
  return seen;
}

test.each(["bad", "-1", "1.5", "9007199254740992"])(
  "malformed content-length %s denies and cancels body",
  async (length) => {
    const { response, wasCanceled } = streamedResponse(200, {
      "Content-Type": "application/json", "Content-Length": length,
    });
    await expect(proxyFixture(response)).rejects.toThrow("invalid_content_length");
    expect(wasCanceled()).toBe(true);
  },
);

test("declared oversized length denies before reading stream", async () => {
  const { response, wasCanceled } = streamedResponse(200, {
    "Content-Type": "application/json",
    "Content-Length": String(MAX_CONTROL_BODY_BYTES + 1),
  });
  await expect(proxyFixture(response)).rejects.toThrow("oversized_response");
  expect(wasCanceled()).toBe(true);
});

test.each([401, 503])("non-success upstream %s stream is canceled without revealing body", async (code) => {
  const { response, wasCanceled } = streamedResponse(code, { "Content-Type": "application/json" });
  const result = await proxyFixture(response);
  expect(result.status).toBe(code === 401 ? 401 : 502);
  expect(result.json).toEqual({ error: code === 401 ? "control_api_denied" : "upstream_unavailable" });
  expect(wasCanceled()).toBe(true);
});

test("invalid content-type stream is canceled", async () => {
  const { response, wasCanceled } = streamedResponse(200, { "Content-Type": "text/html" });
  const result = await proxyFixture(response);
  expect(result.status).toBe(502);
  expect(result.json).toEqual({ error: "invalid_upstream_content_type" });
  expect(wasCanceled()).toBe(true);
});

test("valid bounded JSON still passes unchanged", async () => {
  const payload = '{"ok":true}';
  const { response, wasCanceled } = streamedResponse(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(payload)),
  });
  const result = await proxyFixture(response);
  expect(result.status).toBe(200);
  expect(JSON.parse(result.data.toString("utf8"))).toEqual({ ok: true });
  expect(wasCanceled()).toBe(false);
});
