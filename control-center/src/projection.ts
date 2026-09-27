import type { Collection, ControlSnapshot } from "./types";

const unknown = (reason: string): Collection => ({
  state: "unknown", items: null, freshness: "unknown", reason,
});

export function selectDomain(snapshot: ControlSnapshot | null, key: string): Collection {
  if (!snapshot) return unknown("Snapshot not connected.");

  const collections = (snapshot.collections ?? {}) as Record<string, Collection>;
  if (key in collections) return collections[key];

  const flags = (snapshot.flags ?? {}) as Record<string, unknown>;
  if (key === "attention") {
    const meta = flags.attentionCollection as Partial<Collection> | undefined;
    return {
      state: meta?.state ?? "unknown",
      items: meta?.state === "ready" ? (snapshot.attention as unknown[] ?? []) : null,
      provenance: meta?.provenance,
      freshness: snapshot.freshness && typeof snapshot.freshness === "object"
        ? String((snapshot.freshness as Record<string, unknown>).state ?? "unknown") as Collection["freshness"]
        : "unknown",
    };
  }
  if (key === "activity") {
    const meta = flags.activityCollection as Partial<Collection> | undefined;
    return { state: meta?.state ?? "ready", items: snapshot.activity as unknown[] ?? [], provenance: meta?.provenance, freshness: "unknown" };
  }
  if (key === "capabilities") {
    return { state: Array.isArray(snapshot.capabilities) ? "ready" : "unknown", items: Array.isArray(snapshot.capabilities) ? snapshot.capabilities : null, freshness: "unknown" };
  }
  if (key === "system") {
    const system = flags.system as Record<string, unknown> | undefined;
    return { state: String(system?.state ?? "unknown") as Collection["state"], items: system ? [system] : null, provenance: system?.provenance as Record<string, unknown> | undefined, freshness: "unknown" };
  }
  return unknown("Domain is not projected by velvetos.control.v1.");
}

export function selectCapabilities(snapshot: ControlSnapshot | null, domains?: readonly string[]): Collection {
  if (!snapshot || !Array.isArray(snapshot.capabilities)) return unknown("Capability catalog not connected.");
  const items = (snapshot.capabilities as Record<string, unknown>[]).filter((item) =>
    !domains?.length || domains.includes(String(item.domain ?? "")),
  );
  return { state: "ready", items, count: items.length, freshness: "fresh" };
}

export function selectIntegrations(snapshot: ControlSnapshot | null): Collection {
  if (!snapshot) return unknown("Snapshot not connected.");
  const collections = (snapshot.collections ?? {}) as Record<string, Collection>;
  const envelope = collections.integrations;
  if (envelope) return envelope;
  if (Array.isArray(snapshot.integrations)) {
    return { state: "ready", items: snapshot.integrations, count: snapshot.integrations.length, freshness: "fresh" };
  }
  return unknown("Integration registry not projected by the Control API.");
}

export function selectSources(snapshot: ControlSnapshot | null): Collection {
  if (!snapshot) return unknown("Snapshot not connected.");
  const collections = (snapshot.collections ?? {}) as Record<string, Collection>;
  const items = Object.entries(collections).map(([id, value]) => ({ id, ...value }));
  return { state: "ready", items, count: items.length, freshness: "live" };
}

export function selectRuntime(snapshot: ControlSnapshot | null): Collection {
  if (!snapshot) return unknown("Snapshot not connected.");
  const modules = Array.isArray(snapshot.modules) ? snapshot.modules as unknown[] : [];
  const health = Array.isArray(snapshot.health) ? snapshot.health as unknown[] : [];
  return {
    state: "ready",
    items: [
      ...modules.map((item) => ({ kind: "module", ...(item as Record<string, unknown>) })),
      ...health.map((item) => ({ kind: "health", ...(item as Record<string, unknown>) })),
    ],
    count: modules.length + health.length,
    freshness: "fresh",
  };
}
