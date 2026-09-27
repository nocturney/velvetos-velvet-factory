import { describe, expect, it } from "vitest";
import { selectDomain } from "./projection";
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
  it("has unique module ids and no unsafe actions in milestone 1", () => {
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
