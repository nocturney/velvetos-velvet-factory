import type { ControlSnapshot } from "./types";

export type SnapshotHealth = "live" | "fresh" | "stale" | "unknown" | "disconnected";
export const MAX_SNAPSHOT_AGE_MS = 90_000;

export function isControlSnapshot(value: unknown): value is ControlSnapshot {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    (value as { schema?: unknown }).schema === "velvetos.control.v1");
}

export function evaluateSnapshotHealth(
  snapshot: ControlSnapshot | null,
  nowMs = Date.now(),
  maxAgeMs = MAX_SNAPSHOT_AGE_MS,
): SnapshotHealth {
  if (!snapshot) return "disconnected";
  if (!isControlSnapshot(snapshot)) return "unknown";
  if (snapshot.connection === "disconnected") return "disconnected";
  if (snapshot.connection !== "connected") return "unknown";

  const freshness = snapshot.freshness && typeof snapshot.freshness === "object"
    ? snapshot.freshness as Record<string, unknown> : {};
  const state = freshness.state;
  if (!["live", "fresh", "stale", "unknown"].includes(String(state))) return "unknown";
  // Only the source observation time proves freshness; wrapper generatedAt never substitutes for it.
  const verifiedAt = freshness.verifiedAt;
  if (typeof verifiedAt !== "string") return "unknown";
  const timestamp = Date.parse(verifiedAt);
  if (!Number.isFinite(timestamp) || timestamp > nowMs + 30_000) return "unknown";
  if (state === "stale" || nowMs - timestamp > maxAgeMs) return "stale";
  return state as SnapshotHealth;
}
