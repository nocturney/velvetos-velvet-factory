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
  // Set only for a verified, short-lived signed copy served by the portal.
  transport?: "signed_snapshot";
  validUntil?: string;
}

const MAX_FLEET_MACHINES = 300;
const PLATFORMS = ["windows", "macos", "linux", "unknown"] as const;
const STATUSES = ["online", "offline", "unknown"] as const;
const FRESHNESS = ["live", "stale", "unknown"] as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

const asText = (value: unknown, limit: number): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= limit ? value : null;

const asTimestamp = (value: unknown): string | null => {
  const text = asText(value, 64);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
};

const asBytes = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? value as T : fallback;

// Anything unrecognised degrades to "unknown"; a machine is only "online" with a
// current observation (live freshness and a valid lastSeen). Stale or unverified
// records keep their stale/unknown meaning and never appear as reported online.
function readMachine(raw: unknown): FleetMachine {
  const record = asRecord(raw);
  if (!record) throw new Error("Invalid Fleet machine");
  const id = asText(record.id, 128);
  const name = asText(record.name, 120);
  if (!id || !name) throw new Error("Invalid Fleet machine identity");

  const freshness = oneOf(record.freshness, FRESHNESS, "unknown");
  const lastSeen = asTimestamp(record.lastSeen);
  const collectedAt = asTimestamp(record.collectedAt);
  const reported = oneOf(record.status, STATUSES, "unknown");
  const status = reported === "online" && (freshness !== "live" || !lastSeen)
    ? "unknown" : reported;

  const os = asRecord(record.os) ?? {};
  const hardware = asRecord(record.hardware) ?? {};
  const memory = asRecord(hardware.memory) ?? {};
  const cores = hardware.cpuCores;

  return {
    id,
    name,
    platform: oneOf(record.platform, PLATFORMS, "unknown"),
    status,
    freshness,
    collectedAt,
    lastSeen,
    os: { name: asText(os.name, 180), version: asText(os.version, 90) },
    hardware: {
      cpu: asText(hardware.cpu, 160),
      cpuCores: typeof cores === "number" && Number.isInteger(cores) && cores >= 0 ? cores : null,
      memoryTotalBytes: asBytes(memory.totalBytes),
      memoryFreeBytes: asBytes(memory.freeBytes),
    },
  };
}

export async function getFleetMachines(signal?: AbortSignal): Promise<FleetMachinesSnapshot> {
  const response = await fetch("/api/fleet/v1/machines", {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new Error(`Fleet unavailable (HTTP ${response.status})`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Invalid Fleet response");
  }
  const data = asRecord(body);
  if (!data) throw new Error("Invalid Fleet response");
  if (data.schema !== "velvetos.portal.fleet-machines.v1" ||
      data.source !== "Velvet Fleet Console" ||
      !Array.isArray(data.machines) || data.machines.length > MAX_FLEET_MACHINES ||
      data.count !== data.machines.length)
    throw new Error("Invalid Fleet schema");
  const fetchedAt = asTimestamp(data.fetchedAt);
  if (!fetchedAt) throw new Error("Invalid Fleet schema");

  const machines = data.machines.map(readMachine);
  if (new Set(machines.map((machine) => machine.id)).size !== machines.length)
    throw new Error("Duplicate Fleet machine");

  if (data.transport === undefined) {
    return {
      schema: "velvetos.portal.fleet-machines.v1",
      source: "Velvet Fleet Console",
      fetchedAt,
      count: machines.length,
      machines,
    };
  }
  // A signed copy is shown only while it is still inside its validity window.
  const validUntil = asTimestamp(data.validUntil);
  if (data.transport !== "signed_snapshot" || !validUntil) throw new Error("Invalid Fleet schema");
  if (Date.parse(validUntil) <= Date.now()) throw new Error("Fleet snapshot expired");
  return {
    schema: "velvetos.portal.fleet-machines.v1",
    source: "Velvet Fleet Console",
    fetchedAt,
    count: machines.length,
    machines,
    transport: "signed_snapshot",
    validUntil,
  };
}
