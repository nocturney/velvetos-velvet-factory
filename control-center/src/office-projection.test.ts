import { describe, expect, it } from "vitest";
import { selectOfficePolicy } from "./office-projection";
import { selectDomain } from "./projection";
import { moduleRegistry } from "./registry";
import type { ControlSnapshot } from "./types";

const snap = (flags: Record<string, unknown>) =>
  ({ schema: "velvetos.control.v1", flags }) as ControlSnapshot;

describe("Office projection remains source-honest", () => {
  it("never presents disconnected policy as ready or as false", () => {
    expect(selectOfficePolicy(null).state).toBe("unknown");
    expect(selectOfficePolicy(null).items).toBeNull();
  });
  it("returns unknown when system source is missing or unhealthy", () => {
    expect(selectOfficePolicy(snap({ policyPresent: true })).state).toBe("unknown");
    expect(selectOfficePolicy(snap({ system: { state: "unavailable" }, policyPresent: true })).items).toBeNull();
  });
  it("does not invent unspecified flags or an empty lock list", () => {
    const policy = selectOfficePolicy(snap({
      system: { state: "ready" }, policyPresent: true, dontBotherChristian: true,
      sourcesOfTruthCount: 2,
    }));
    expect(policy.state).toBe("unknown");
    expect(policy.items).toBeNull();
  });
  it("shows only validated control-plane facts and preserves provenance", () => {
    const policy = selectOfficePolicy(snap({
      system: { state: "ready", provenance: { source: "office/control-plane.json" } },
      policyPresent: false, dontBotherChristian: true, locks: ["operator"], sourcesOfTruthCount: 3,
    }));
    expect(policy.state).toBe("ready");
    expect(policy.items).toEqual([{ policyPresent: false, dontBotherChristian: true, lockCount: 1, sourcesOfTruthCount: 3 }]);
    expect(policy.provenance?.source).toBe("office/control-plane.json");
  });
  it("rejects malformed settings", () => {
    expect(selectOfficePolicy(snap({
      system: { state: "ready" }, policyPresent: "false",
      dontBotherChristian: true, locks: [], sourcesOfTruthCount: 3,
    })).state).toBe("unknown");
  });
  it("does not invent a live agent desk when canonical collection is absent", () => {
    const desk = selectDomain(snap({ system: { state: "ready" } }), "agents");
    expect(desk.state).toBe("unknown");
    expect(desk.items).toBeNull();
  });
  it("preserves unavailable agent collection as unavailable, not empty", () => {
    const desk = selectDomain({
      schema: "velvetos.control.v1",
      collections: { agents: { state: "unavailable", items: null, count: null, reason: "instance desk offline" } },
    } as ControlSnapshot, "agents");
    expect(desk.state).toBe("unavailable");
    expect(desk.items).toBeNull();
    expect(desk.count).toBeNull();
  });
  it("exposes Office view but no mutating actions in its modules", () => {
    const office = moduleRegistry.filter((definition) => definition.views.includes("office"));
    expect(office.map((m) => m.id)).toContain("office-desk");
    expect(office.map((m) => m.id)).toContain("office-policy");
    expect(office.map((m) => m.id)).toContain("attention");
    expect(office.every((m) => m.actions.length === 0)).toBe(true);
  });
});
