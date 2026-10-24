import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleSearch, type PaletteSearch } from "./CommandPalette";
import type { SearchResult } from "./types";

interface Deferred { resolve: (items: SearchResult[]) => void; reject: (err: Error) => void; signal: AbortSignal }

// Each call returns a promise the test settles by hand, so completion order is explicit.
function controlledSearch() {
  const calls: Array<{ query: string } & Deferred> = [];
  const search: PaletteSearch = (query, signal) => new Promise<SearchResult[]>((resolve, reject) => {
    calls.push({ query, resolve, reject, signal });
  });
  return { search, calls };
}

function recorder() {
  const events: string[] = [];
  const shown: SearchResult[][] = [];
  return {
    events,
    shown,
    handlers: {
      onStart: () => events.push("start"),
      onResults: (items: SearchResult[]) => { events.push("results"); shown.push(items); },
      onError: () => events.push("error"),
    },
  };
}

const item = (title: string): SearchResult => ({ id: title, title });

describe("scheduleSearch (CommandPalette race guard)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the 180ms debounce: nothing is requested before the delay and a cancelled search never requests", async () => {
    const { search, calls } = controlledSearch();
    const rec = recorder();
    const cancel = scheduleSearch("ab", search, rec.handlers);
    vi.advanceTimersByTime(179);
    expect(calls).toHaveLength(0);
    cancel();
    vi.advanceTimersByTime(500);
    expect(calls).toHaveLength(0);
    expect(rec.events).toEqual([]);
  });

  it("delivers a single search's results and start status once debounced", async () => {
    const { search, calls } = controlledSearch();
    const rec = recorder();
    scheduleSearch("abc", search, rec.handlers);
    vi.advanceTimersByTime(180);
    expect(calls.map((c) => c.query)).toEqual(["abc"]);
    calls[0].resolve([item("A")]);
    await vi.runAllTimersAsync();
    expect(rec.events).toEqual(["start", "results"]);
    expect(rec.shown).toEqual([[item("A")]]);
  });

  it("drops an old success that resolves after a newer query has already succeeded", async () => {
    const { search, calls } = controlledSearch();
    const rec = recorder();
    const cancelOld = scheduleSearch("old", search, rec.handlers);
    vi.advanceTimersByTime(180);
    cancelOld();
    scheduleSearch("new", search, rec.handlers);
    vi.advanceTimersByTime(180);
    calls[1].resolve([item("NEW")]);
    await vi.runAllTimersAsync();
    calls[0].resolve([item("OLD")]);
    await vi.runAllTimersAsync();
    expect(rec.shown).toEqual([[item("NEW")]]);
  });

  it("drops an old failure that rejects after a newer query has succeeded", async () => {
    const { search, calls } = controlledSearch();
    const rec = recorder();
    const cancelOld = scheduleSearch("old", search, rec.handlers);
    vi.advanceTimersByTime(180);
    cancelOld();
    scheduleSearch("new", search, rec.handlers);
    vi.advanceTimersByTime(180);
    calls[1].resolve([item("NEW")]);
    await vi.runAllTimersAsync();
    calls[0].reject(new Error("Control API 503"));
    await vi.runAllTimersAsync();
    expect(rec.events).not.toContain("error");
    expect(rec.shown).toEqual([[item("NEW")]]);
  });

  it("drops an old success that resolves after the palette was closed and reopened", async () => {
    const { search, calls } = controlledSearch();
    const rec = recorder();
    const cancelBeforeClose = scheduleSearch("same", search, rec.handlers);
    vi.advanceTimersByTime(180);
    cancelBeforeClose(); // close: effect cleanup
    scheduleSearch("same", search, rec.handlers); // reopen with the same query
    vi.advanceTimersByTime(180);
    calls[0].resolve([item("STALE")]);
    await vi.runAllTimersAsync();
    expect(rec.shown).toEqual([]);
    calls[1].resolve([item("FRESH")]);
    await vi.runAllTimersAsync();
    expect(rec.shown).toEqual([[item("FRESH")]]);
  });

  it("aborts the in-flight request when superseded or closed", () => {
    const { search, calls } = controlledSearch();
    const rec = recorder();
    const cancel = scheduleSearch("abc", search, rec.handlers);
    vi.advanceTimersByTime(180);
    expect(calls[0].signal.aborted).toBe(false);
    cancel();
    expect(calls[0].signal.aborted).toBe(true);
  });

  it("does not report an error when the cancelled request rejects with an abort", async () => {
    const { search, calls } = controlledSearch();
    const rec = recorder();
    const cancel = scheduleSearch("abc", search, rec.handlers);
    vi.advanceTimersByTime(180);
    cancel();
    calls[0].reject(new DOMException("aborted", "AbortError"));
    await vi.runAllTimersAsync();
    expect(rec.events).toEqual(["start"]);
  });
});
