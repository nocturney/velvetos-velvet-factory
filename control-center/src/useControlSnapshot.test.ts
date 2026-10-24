import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlApi } from "./control-api";
import { useControlSnapshot } from "./useControlSnapshot";
import type { ControlSnapshot } from "./types";

// Minimal hook harness: the hook is called once, so state slots are read in call order.
const harness = vi.hoisted(() => ({
  slots: [] as Array<{ value: unknown }>,
  cursor: 0,
  cleanup: undefined as undefined | (() => void),
}));

vi.mock("react", () => ({
  useState: (init: unknown) => {
    const index = harness.cursor++;
    if (!harness.slots[index]) harness.slots[index] = { value: init };
    const slot = harness.slots[index];
    return [slot.value, (next: unknown) => { slot.value = next; }];
  },
  useEffect: (effect: () => void | (() => void)) => {
    harness.cleanup = effect() ?? undefined;
  },
}));

const NOW = Date.parse("2026-10-24T08:00:00.000Z");
function snapshot(): ControlSnapshot {
  return {
    schema: "velvetos.control.v1",
    connection: "connected",
    generatedAt: new Date(NOW).toISOString(),
    freshness: { state: "live", verifiedAt: new Date(NOW).toISOString() },
  } as ControlSnapshot;
}

function mountHook() {
  harness.slots = [];
  harness.cursor = 0;
  harness.cleanup = undefined;
  useControlSnapshot();
  return {
    snapshot: () => harness.slots[0].value as ControlSnapshot | null,
    error: () => harness.slots[1].value as string,
  };
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("useControlSnapshot deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });

  afterEach(() => {
    harness.cleanup?.();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("drops a previous live snapshot when a refresh never settles", async () => {
    const first = snapshot();
    vi.spyOn(controlApi, "snapshot")
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => new Promise<ControlSnapshot>(() => {}));
    const view = mountHook();
    await flush();
    expect(view.snapshot()).toEqual(first);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(view.snapshot()).toEqual(first);

    await vi.advanceTimersByTimeAsync(8_000);
    await flush();
    expect(view.snapshot()).toBeNull();
    expect(view.error()).not.toBe("");
  });

  it("does not let a late success from a timed-out refresh resurrect the snapshot", async () => {
    const first = snapshot();
    let resolveLate: (value: ControlSnapshot) => void = () => {};
    vi.spyOn(controlApi, "snapshot")
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => new Promise<ControlSnapshot>((resolve) => { resolveLate = resolve; }));
    const view = mountHook();
    await flush();

    await vi.advanceTimersByTimeAsync(30_000 + 8_000);
    await flush();
    expect(view.snapshot()).toBeNull();

    resolveLate(snapshot());
    await flush();
    expect(view.snapshot()).toBeNull();
    expect(view.error()).not.toBe("");
  });

  it("keeps a valid snapshot when refreshes settle before the deadline", async () => {
    const first = snapshot();
    const second = snapshot();
    vi.spyOn(controlApi, "snapshot")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const view = mountHook();
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(view.snapshot()).toEqual(second);
    expect(view.error()).toBe("");
  });
});
