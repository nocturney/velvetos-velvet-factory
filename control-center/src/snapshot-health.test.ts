import { describe, expect, it } from "vitest";
import { evaluateSnapshotHealth, isControlSnapshot, MAX_SNAPSHOT_AGE_MS } from "./snapshot-health";
import type { ControlSnapshot } from "./types";

const NOW = Date.parse("2026-10-15T08:00:00.000Z");
function observed(fields: Record<string, unknown> = {}) {
  return {
    schema: "velvetos.control.v1",
    connection: "connected",
    generatedAt: new Date(NOW).toISOString(),
    freshness: { state: "live", verifiedAt: new Date(NOW).toISOString() },
    ...fields,
  } as ControlSnapshot;
}

describe("portal snapshot truth", () => {
  it("does not treat a null/unavailable snapshot as live", () => {
    expect(evaluateSnapshotHealth(null, NOW)).toBe("disconnected");
  });
  it("requires the expected canonical schema", () => {
    expect(isControlSnapshot({ schema: "not_control" })).toBe(false);
    expect(evaluateSnapshotHealth({ schema: "not_control" } as ControlSnapshot, NOW)).toBe("unknown");
  });
  it("uses actual upstream connection status", () => {
    expect(evaluateSnapshotHealth(observed({ connection: "disconnected" }), NOW)).toBe("disconnected");
    expect(evaluateSnapshotHealth(observed({ connection: "unknown" }), NOW)).toBe("unknown");
  });
  it("preserves live vs fresh vs stale state explicitly", () => {
    expect(evaluateSnapshotHealth(observed(), NOW)).toBe("live");
    expect(evaluateSnapshotHealth(observed({ freshness: { state: "fresh", verifiedAt: new Date(NOW).toISOString() } }), NOW)).toBe("fresh");
    expect(evaluateSnapshotHealth(observed({ freshness: { state: "stale", verifiedAt: new Date(NOW).toISOString() } }), NOW)).toBe("stale");
  });
  it("marks expired observations stale even when server claims live", () => {
    const old = new Date(NOW - MAX_SNAPSHOT_AGE_MS - 1).toISOString();
    expect(evaluateSnapshotHealth(observed({ freshness: { state: "live", verifiedAt: old } }), NOW)).toBe("stale");
  });
  it("prefers the source observation time over a fresh generatedAt wrapper", () => {
    const old = new Date(NOW - 180_000).toISOString();
    expect(evaluateSnapshotHealth(observed({ freshness: { state: "live", verifiedAt: old } }), NOW)).toBe("stale");
  });
  it("never fabricates recency when timestamps are absent or invalid", () => {
    expect(evaluateSnapshotHealth(observed({ generatedAt: undefined, freshness: { state: "live" } }), NOW)).toBe("unknown");
    expect(evaluateSnapshotHealth(observed({ freshness: { state: "live", verifiedAt: "no-date" } }), NOW)).toBe("unknown");
    expect(evaluateSnapshotHealth(observed({ freshness: { state: "unknown", verifiedAt: new Date(NOW).toISOString() } }), NOW)).toBe("unknown");
  });
  it("treats an observation too far in the future as untrustworthy", () => {
    const future = new Date(NOW + 120_000).toISOString();
    expect(evaluateSnapshotHealth(observed({ freshness: { state: "live", verifiedAt: future } }), NOW)).toBe("unknown");
  });
  it("never reports live or fresh from a wrapper generatedAt without a source observation", () => {
    expect(evaluateSnapshotHealth(observed({ freshness: { state: "live" } }), NOW)).toBe("unknown");
    expect(evaluateSnapshotHealth(observed({ freshness: { state: "fresh" } }), NOW)).toBe("unknown");
  });
  it("does not fall back to generatedAt for empty or non-string verifiedAt", () => {
    expect(evaluateSnapshotHealth(observed({ freshness: { state: "live", verifiedAt: "" } }), NOW)).toBe("unknown");
    expect(evaluateSnapshotHealth(observed({ freshness: { state: "fresh", verifiedAt: 1234 } }), NOW)).toBe("unknown");
    expect(evaluateSnapshotHealth(observed({ freshness: { state: "fresh", verifiedAt: null } }), NOW)).toBe("unknown");
  });
  it("keeps the 90s age boundary inclusive and the +30s future skew allowance", () => {
    const edge = new Date(NOW - MAX_SNAPSHOT_AGE_MS).toISOString();
    const skew = new Date(NOW + 30_000).toISOString();
    expect(evaluateSnapshotHealth(observed({ freshness: { state: "fresh", verifiedAt: edge } }), NOW)).toBe("fresh");
    expect(evaluateSnapshotHealth(observed({ freshness: { state: "live", verifiedAt: skew } }), NOW)).toBe("live");
  });
});
