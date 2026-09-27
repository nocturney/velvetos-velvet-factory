import { describe, expect, it } from "vitest";
import { selectCapabilities, selectDomain, selectIntegrations, selectRuntime, selectSources } from "./projection";
import { moduleRegistry } from "./registry";
import type { ControlSnapshot } from "./types";

describe("truth-preserving projection", () => {
  it("keeps jobs needs_sync distinct from an empty ready list", () => {
    const snapshot = {
      schema: "velvetos.control.v1",
      collections: { jobs: { state: "needs_sync", items: null, count: null, reason: "refresh required" } },
    } as ControlSnapshot;
    const jobs = selectDomain(snapshot, "jobs");
    expect(jobs.state).toBe("needs_sync");
    expect(jobs.items).toBeNull();
    expect(jobs.count).toBeNull();
  });

  it("maps ready attention envelope to the actual attention items", () => {
    const snapshot = {
      schema: "velvetos.control.v1",
      flags: { attentionCollection: { state: "ready", count: 1 } },
      attention: [{ id: "a1", title: "One item" }],
      freshness: { state: "fresh" },
    } as ControlSnapshot;
    const attention = selectDomain(snapshot, "attention");
    expect(attention.state).toBe("ready");
    expect(attention.items).toHaveLength(1);
  });

  it("does not invent an unavailable domain", () => {
    const value = selectDomain({ schema: "velvetos.control.v1" }, "production");
    expect(value.state).toBe("unknown");
    expect(value.items).toBeNull();
  });
});

describe("UI module registry", () => {
  it("has unique module ids and no unsafe actions", () => {
    const ids = moduleRegistry.map((module) => module.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(moduleRegistry.every((module) => module.actions.length === 0)).toBe(true);
  });

  it("binds rendering and selection at the registry boundary", () => {
    expect(moduleRegistry.every((module) =>
      typeof module.component === "function" &&
      typeof module.select === "function" &&
      typeof module.isAvailable === "function"
    )).toBe(true);
  });
});

describe("control-center information map", () => {
  const snapshot = {
    schema: "velvetos.control.v1",
    capabilities: [
      { id: "gmail.read", domain: "gmail", status: "AVAILABLE" },
      { id: "instagram.publish", domain: "instagram", status: "APPROVAL_REQUIRED" },
    ],
    integrations: [
      { id: "gmail", status: "AVAILABLE", sourceStatus: "ready" },
      { id: "studiomcphub", status: "NEEDS_AUTH", sourceStatus: "needsAuth" },
    ],
    collections: {
      jobs: { state: "ready", items: [], count: 0 },
      production: { state: "unavailable", items: null, reason: "not projected" },
    },
    modules: [{ id: "living-studio", status: "projection" }],
    health: [{ id: "watchdog", status: "ok" }],
  } as ControlSnapshot;

  it("filters capabilities by canonical domains without changing statuses", () => {
    const gmail = selectCapabilities(snapshot, ["gmail"]);
    expect(gmail.items).toHaveLength(1);
    expect((gmail.items?.[0] as Record<string, unknown>).status).toBe("AVAILABLE");
  });

  it("projects the canonical integration registry without reclassifying it", () => {
    const integrations = selectIntegrations(snapshot);
    expect(integrations.state).toBe("ready");
    expect(integrations.items).toHaveLength(2);
    expect((integrations.items?.[1] as Record<string, unknown>).status).toBe("NEEDS_AUTH");
  });

  it("projects all source collections including unavailable sources", () => {
    const sources = selectSources(snapshot);
    expect(sources.items).toHaveLength(2);
    expect((sources.items?.[1] as Record<string, unknown>).state).toBe("unavailable");
  });

  it("combines runtime modules and health sensors without inventing entries", () => {
    const runtime = selectRuntime(snapshot);
    expect(runtime.items).toHaveLength(2);
    expect(runtime.count).toBe(2);
  });

  it("exposes a dedicated tools view in the registry", () => {
    expect(moduleRegistry.some((module) => module.views.includes("tools"))).toBe(true);
  });
});
