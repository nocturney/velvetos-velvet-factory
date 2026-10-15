import { describe, expect, it } from "vitest";
import { selectProductionRows } from "./production-projection";
import { selectDomain } from "./projection";
import { moduleRegistry } from "./registry";
import type { ControlSnapshot } from "./types";

describe("production canonical read-only projection", () => {
  it("does not infer printers, events or 0 from unavailable collection", () => {
    const x = selectProductionRows({ state: "unavailable", items: null, count: null });
    expect(x.verified).toBe(false);
    expect(x.printers).toBeNull();
    expect(x.printerCount).toBeNull();
    expect(x.eventCount).toBeNull();
  });
  it("rejects false ready when payload items are null", () => {
    expect(selectProductionRows({ state: "ready", items: null }).verified).toBe(false);
  });
  it("keeps actual ready-empty different from unavailable", () => {
    const x = selectProductionRows({ state: "ready", items: [], printerCount: 0, eventCount: 0 });
    expect(x.verified).toBe(true);
    expect(x.printerCount).toBe(0);
    expect(x.eventCount).toBe(0);
  });
  it("only counts source-defined kind categories", () => {
    const x = selectProductionRows({ state: "ready", items: [
      { kind: "printer", id: "p1", status: "unknown" },
      { kind: "print_event", id: "e1", status: "failed" },
      { kind: "other", id: "o1" },
    ] });
    expect(x.printerCount).toBe(1);
    expect(x.eventCount).toBe(1);
    expect(x.printers?.[0].status).toBe("unknown");
    expect(x.events?.[0].status).toBe("failed");
  });
  it("rejects malformed negative or fractional source counts", () => {
    const x = selectProductionRows({ state: "ready", items: [], printerCount: -99, eventCount: 2.5 });
    expect(x.printerCount).toBe(0);
    expect(x.eventCount).toBe(0);
  });
  it("does not invent material metadata when absent", () => {
    expect(selectProductionRows({ state: "ready", items: [] }).materialCount).toBeNull();
    expect(selectProductionRows({ state: "ready", items: [], materials: [] }).materialCount).toBe(0);
  });
  it("preserves true canonical unavailable model envelope", () => {
    const model = selectDomain({
      schema: "velvetos.control.v1",
      collections: { models: { state: "needs_sync", items: null, count: null, reason: "shelf stale" } },
    } as ControlSnapshot, "models");
    expect(model.state).toBe("needs_sync");
    expect(model.items).toBeNull();
  });
  it("registers production and model shelf only as read-only components", () => {
    const defs = moduleRegistry.filter((m) => m.views.includes("production"));
    expect(defs.map((m) => m.id)).toContain("production-status");
    expect(defs.map((m) => m.id)).toContain("production-shelf");
    expect(defs.every((m) => m.actions.length === 0)).toBe(true);
  });
});
