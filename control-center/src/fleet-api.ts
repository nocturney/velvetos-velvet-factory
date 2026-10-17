// One-origin, read-only Fleet projection served by the VelvetOS portal.
// No host IDs, access tokens, deployment controls or URLs supplied by the browser.
export interface FleetMachine {
  id: string;
  name: string;
  platform: "windows" | "macos" | "linux" | "unknown";
  status: "online" | "offline" | "unknown";
  freshness: "live" | "stale" | "unknown";
  collectedAt: string | null;
  lastSeen: string | null;
  os: { name: string | null; version: string | null };
  hardware: {
    cpu: string | null;
    cpuCores: number | null;
    memoryTotalBytes: number | null;
    memoryFreeBytes: number | null;
  };
}

export interface FleetMachinesSnapshot {
  schema: "velvetos.portal.fleet-machines.v1";
  source: "Velvet Fleet Console";
  fetchedAt: string;
  count: number;
  machines: FleetMachine[];
}

export async function getFleetMachines(signal?: AbortSignal): Promise<FleetMachinesSnapshot> {
  const response = await fetch("/api/fleet/v1/machines", {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new Error(`Fleet unavailable (HTTP ${response.status})`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") throw new Error("Invalid Fleet response");
  const data = body as Record<string, unknown>;
  if (data.schema !== "velvetos.portal.fleet-machines.v1" ||
      !Array.isArray(data.machines) || data.count !== data.machines.length)
    throw new Error("Invalid Fleet schema");
  return data as unknown as FleetMachinesSnapshot;
}
