import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CONTROL_REQUEST_TIMEOUT_MS, proxyControlRequest } from "../control-proxy-boundary.mjs";

const LATE_SECRET_BODY = '{"schema":"velvetos.control.v1","late":"must-not-reach-browser"}';
const originalFetch = globalThis.fetch;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

// Records every browser-facing write so a late success can be detected after the deadline.
function recordingResponse() {
  const writes = [];
  const res = {
    writeHead(status, headers) { writes.push({ kind: "head", status, headers }); },
    end(data) { writes.push({ kind: "end", data: data.toString("utf8") }); },
  };
  return { res, writes };
}

function runProxy({ res, identityToken = async () => "" }) {
  let settled = false;
  const jsonWrites = [];
  const promise = proxyControlRequest({
    req: { method: "GET" }, res,
    url: new URL("http://127.0.0.1/api/control/v1/snapshot"),
    upstream: "https://control.example.test",
    appToken: "fixture-only", identityToken,
    writeJson(_res, status, payload) { jsonWrites.push({ status, payload }); },
  }).then(() => { settled = true; }, (error) => { settled = true; throw error; });
  promise.catch(() => {});
  return { promise, isSettled: () => settled, jsonWrites };
}

async function expectSanitizedTimeout(run, writes) {
  await vi.advanceTimersByTimeAsync(CONTROL_REQUEST_TIMEOUT_MS);
  expect(run.isSettled()).toBe(true);
  expect(run.jsonWrites).toEqual([{ status: 502, payload: { error: "upstream_unavailable" } }]);
  expect(writes).toEqual([]);
}

test("fetch headers that ignore abort are answered with a sanitized 502 at the 8s deadline", async () => {
  let lateResolve;
  let seenSignal;
  globalThis.fetch = (_url, options) => {
    seenSignal = options.signal;
    return new Promise((resolve) => { lateResolve = resolve; });
  };
  const { res, writes } = recordingResponse();
  const run = runProxy({ res });

  await expectSanitizedTimeout(run, writes);
  expect(seenSignal.aborted).toBe(true);

  // An upstream that eventually answers after the deadline must not produce a 200 or any secret.
  lateResolve(new Response(LATE_SECRET_BODY, {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  await vi.advanceTimersByTimeAsync(0);
  expect(writes).toEqual([]);
  expect(run.jsonWrites).toHaveLength(1);
});

test("a streaming body whose reader stalls and ignores cancel is answered at the 8s deadline", async () => {
  let canceled = false;
  const stalled = new ReadableStream({
    start(controller) {
      // Headers arrive, then the body never produces a chunk and never closes.
      controller.enqueue(new TextEncoder().encode('{"ok":'));
    },
    pull() { return new Promise(() => {}); },
    cancel() {
      canceled = true;
      // A broken upstream never settles cancellation; the deadline must not await it.
      return new Promise(() => {});
    },
  });
  globalThis.fetch = async () => new Response(stalled, {
    status: 200, headers: { "Content-Type": "application/json" },
  });
  const { res, writes } = recordingResponse();
  const run = runProxy({ res });

  await expectSanitizedTimeout(run, writes);
  expect(canceled).toBe(true);
});

test("an identity-token metadata call that never settles is bounded by the same deadline", async () => {
  const fetchSpy = vi.fn(async () => new Response("{}", { headers: { "Content-Type": "application/json" } }));
  globalThis.fetch = fetchSpy;
  const { res, writes } = recordingResponse();
  const run = runProxy({ res, identityToken: () => new Promise(() => {}) });

  await expectSanitizedTimeout(run, writes);
  expect(fetchSpy).not.toHaveBeenCalled();
});
