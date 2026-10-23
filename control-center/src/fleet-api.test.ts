import { afterEach, describe, expect, it, vi } from "vitest";
import { getFleetMachines } from "./fleet-api";

const NOW = "2026-10-15T08:00:00.000Z";
const machine = (props: Record<string, unknown> = {}) => ({
  id: "test-windows", name: "Test Windows", platform: "windows", status: "online",
  freshness: "live", collectedAt: "2026-10-15T07:59:00.000Z",
  lastSeen: "2026-10-15T07:59:30.000Z", os: { name: "Windows", version: "11" },
  hardware: { cpu: "Example CPU", cpuCores: 8,
    memory: { totalBytes: 17179869184, freeBytes: 1024 } },
  ...props,
});
const snapshot = (machines: unknown[] = [machine()], props: Record<string, unknown> = {}) => ({
  schema: "velvetos.portal.fleet-machines.v1", source: "Velvet Fleet Console",
  fetchedAt: NOW, count: machines.length, machines, ...props,
});

function stubFleet(body: unknown, init: ResponseInit = {}) {
  const fetchMock = vi.fn(async () => new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status: 200, headers: { "content-type": "application/json" }, ...init },
  ));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
async function readMachines(machines: unknown[]) {
  stubFleet(snapshot(machines));
  return (await getFleetMachines()).machines;
}

afterEach(() => vi.unstubAllGlobals());

describe("portal Fleet reader", () => {
  it("keeps a valid current projection and strips anything outside the contract", async () => {
    stubFleet(snapshot([machine({ network: { ip: "192.0.2.42" }, password: "SECRET",
      os: { name: "Windows", version: "11", build: "SECRET" } })]));
    const result = await getFleetMachines();
    expect(result.count).toBe(1);
    expect(result.machines[0]).toEqual({
      id: "test-windows", name: "Test Windows", platform: "windows", status: "online",
      freshness: "live", collectedAt: "2026-10-15T07:59:00.000Z",
      lastSeen: "2026-10-15T07:59:30.000Z", os: { name: "Windows", version: "11" },
      hardware: { cpu: "Example CPU", cpuCores: 8,
        memoryTotalBytes: 17179869184, memoryFreeBytes: 1024 },
    });
    const json = JSON.stringify(result);
    for (const secret of ["192.0.2.42", "SECRET", "password", "build"]) expect(json).not.toContain(secret);
  });

  it("preserves hardware memory from the canonical flattened Fleet projection", async () => {
    // Both /api/fleet/v1/machines paths return these FLAT memory keys after
    // projectFleetMachines; legacy nested-only test fixtures hid this contract bug.
    const canonical = machine({ hardware: {
      cpu: "Example CPU", cpuCores: 8,
      memoryTotalBytes: 17179869184, memoryFreeBytes: 1024,
    } });
    for (const signed of [false, true]) {
      stubFleet(snapshot([canonical], signed
        ? { transport: "signed_snapshot", validUntil: new Date(Date.now() + 60_000).toISOString() }
        : {}));
      const [row] = (await getFleetMachines()).machines;
      expect(row.hardware).toEqual({
        cpu: "Example CPU", cpuCores: 8,
        memoryTotalBytes: 17179869184, memoryFreeBytes: 1024,
      });
      vi.unstubAllGlobals();
    }
  });

  it("does not let conflicting nested data override invalid canonical memory counters", async () => {
    const [row] = await readMachines([machine({ hardware: {
      cpu: "Example CPU", cpuCores: 8,
      memoryTotalBytes: null, memoryFreeBytes: -1,
      memory: { totalBytes: 17179869184, freeBytes: 1024 },
    } })]);
    expect(row.hardware.memoryTotalBytes).toBeNull();
    expect(row.hardware.memoryFreeBytes).toBeNull();
  });

  it("never shows a machine online unless it is live with a current lastSeen", async () => {
    const machines = await readMachines([
      machine({ id: "stale-online", freshness: "stale" }),
      machine({ id: "unverified-online", freshness: "unknown" }),
      machine({ id: "no-lastseen", lastSeen: null }),
      machine({ id: "bad-lastseen", lastSeen: "not-a-date" }),
    ]);
    expect(machines.map((m) => [m.id, m.status, m.freshness])).toEqual([
      ["stale-online", "unknown", "stale"],
      ["unverified-online", "unknown", "unknown"],
      ["no-lastseen", "unknown", "live"],
      ["bad-lastseen", "unknown", "live"],
    ]);
  });

  it("coerces unrecognised platform, status and freshness to unknown instead of trusting them", async () => {
    const machines = await readMachines([
      machine({ id: "bad-platform", platform: "amiga" }),
      machine({ id: "bad-status", status: "ONLINE" }),
      machine({ id: "object-status", status: { value: "online" } }),
      machine({ id: "bad-freshness", freshness: "fresh" }),
      machine({ id: "not-offline", status: "offline", freshness: "stale" }),
    ]);
    expect(machines.map((m) => [m.id, m.platform, m.status, m.freshness])).toEqual([
      ["bad-platform", "unknown", "online", "live"],
      ["bad-status", "windows", "unknown", "live"],
      ["object-status", "windows", "unknown", "live"],
      ["bad-freshness", "windows", "unknown", "unknown"],
      ["not-offline", "windows", "offline", "stale"],
    ]);
  });

  it("rejects unsafe hardware and OS shapes as null rather than passing them through", async () => {
    const [m] = await readMachines([machine({
      os: { name: ["Windows"], version: { major: 11 } },
      hardware: { cpu: 42, cpuCores: 2.5,
        memory: { totalBytes: Number.MAX_SAFE_INTEGER + 1, freeBytes: "1024" } },
    })]);
    expect(m.os).toEqual({ name: null, version: null });
    expect(m.hardware).toEqual({ cpu: null, cpuCores: null,
      memoryTotalBytes: null, memoryFreeBytes: null });
  });

  it("fails the whole snapshot when a machine has missing or invalid identity", async () => {
    for (const bad of [machine({ id: undefined }), machine({ name: "" }),
      machine({ id: 7 }), "not-a-machine", null]) {
      stubFleet(snapshot([machine(), bad]));
      await expect(getFleetMachines()).rejects.toThrow(/Invalid Fleet/);
      vi.unstubAllGlobals();
    }
  });

  it("fails closed on duplicate machine IDs, count mismatch, wrong source, and oversize lists", async () => {
    stubFleet(snapshot([machine(), machine()]));
    await expect(getFleetMachines()).rejects.toThrow(/Duplicate Fleet machine/);
    vi.unstubAllGlobals();

    stubFleet(snapshot([machine()], { count: 2 }));
    await expect(getFleetMachines()).rejects.toThrow(/Invalid Fleet schema/);
    vi.unstubAllGlobals();

    stubFleet(snapshot([machine()], { source: "Other Console" }));
    await expect(getFleetMachines()).rejects.toThrow(/Invalid Fleet schema/);
    vi.unstubAllGlobals();

    stubFleet(snapshot([machine()], { fetchedAt: "yesterday" }));
    await expect(getFleetMachines()).rejects.toThrow(/Invalid Fleet schema/);
    vi.unstubAllGlobals();

    const many = Array.from({ length: 301 }, (_, i) => machine({ id: "m" + i }));
    stubFleet(snapshot(many));
    await expect(getFleetMachines()).rejects.toThrow(/Invalid Fleet schema/);
  });

  it("rejects non-JSON bodies and HTTP failures without retaining a prior result", async () => {
    stubFleet("{broken");
    await expect(getFleetMachines()).rejects.toThrow("Invalid Fleet response");
    vi.unstubAllGlobals();

    stubFleet({ error: "fleet_unavailable" }, { status: 502 });
    await expect(getFleetMachines()).rejects.toThrow("Fleet unavailable (HTTP 502)");
  });

  it("issues only a same-origin, read-only GET to the fixed Fleet path", async () => {
    const fetchMock = stubFleet(snapshot([]));
    await getFleetMachines();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/fleet/v1/machines");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
  });

  describe("signed snapshot transport", () => {
    const later = () => new Date(Date.now() + 60_000).toISOString();
    const earlier = () => new Date(Date.now() - 1_000).toISOString();

    it("shows a verified signed copy only with its validity window", async () => {
      const validUntil = later();
      stubFleet(snapshot([machine()], { transport: "signed_snapshot", validUntil }));
      const result = await getFleetMachines();
      expect(result.transport).toBe("signed_snapshot");
      expect(result.validUntil).toBe(validUntil);
      expect(result.machines[0].status).toBe("online");
    });

    it("refuses an expired signed copy instead of showing it as current", async () => {
      stubFleet(snapshot([machine()], { transport: "signed_snapshot", validUntil: earlier() }));
      await expect(getFleetMachines()).rejects.toThrow("Fleet snapshot expired");
    });

    it("fails closed on an unknown transport or a signed copy without a usable expiry", async () => {
      for (const extra of [
        { transport: "live_rpc", validUntil: later() },
        { transport: "signed_snapshot" },
        { transport: "signed_snapshot", validUntil: "tomorrow" },
        { transport: null, validUntil: later() },
      ]) {
        stubFleet(snapshot([machine()], extra));
        await expect(getFleetMachines()).rejects.toThrow(/Invalid Fleet schema/);
        vi.unstubAllGlobals();
      }
    });

    it("still rejects a signed copy with a duplicate or unsafe machine", async () => {
      stubFleet(snapshot([machine(), machine()], { transport: "signed_snapshot", validUntil: later() }));
      await expect(getFleetMachines()).rejects.toThrow(/Duplicate Fleet machine/);
      vi.unstubAllGlobals();

      stubFleet(snapshot([machine({ id: "" })], { transport: "signed_snapshot", validUntil: later() }));
      await expect(getFleetMachines()).rejects.toThrow(/Invalid Fleet machine identity/);
    });
  });
});
