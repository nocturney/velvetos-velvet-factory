// Exact, deliberately small projection from the existing Velvet Fleet Console.
// The portal never becomes another workstation inventory source of truth.
export const SCHEMA = "velvetos.portal.fleet-machines.v1";

const asText = (value, limit = 180) =>
  typeof value === "string" && value.length > 0 && value.length <= limit ? value : null;

const asBytes = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : null;

const asTimestamp = (value) => {
  const text = asText(value, 64);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
};

// Same conservative window as the signed reader: lastSeen may be at most 120s
// before, and 5s after, the trusted projection time. Anything else is unknown.
const ONLINE_MAX_AGE_MS = 120000;
const ONLINE_MAX_FUTURE_MS = 5000;

const onlineClaimHolds = (freshness, lastSeen, fetchedAt) => {
  if (freshness !== "live" || !lastSeen || typeof fetchedAt !== "string") return false;
  const delta = Date.parse(lastSeen) - Date.parse(fetchedAt);
  return delta >= -ONLINE_MAX_AGE_MS && delta <= ONLINE_MAX_FUTURE_MS;
};

export function projectMachine(machine, fetchedAt = new Date().toISOString()) {
  if (!machine || typeof machine !== "object" || Array.isArray(machine)) {
    throw new TypeError("invalid_fleet_machine");
  }
  const id = asText(machine.id, 128);
  const name = asText(machine.name, 120);
  if (!id || !name) throw new TypeError("invalid_fleet_identity");

  const platform = ["windows", "macos", "linux"].includes(machine.platform)
    ? machine.platform : "unknown";
  const freshness = ["live", "stale", "unknown"].includes(machine.freshness)
    ? machine.freshness : "unknown";
  const lastSeen = asTimestamp(machine.lastSeen);
  // A contradictory or stale "online" claim is not evidence of live presence.
  // Downgrade only to unknown: an offline claim is still reported as offline.
  const claimed = ["online", "offline", "unknown"].includes(machine.status)
    ? machine.status : "unknown";
  const status = claimed === "online" && !onlineClaimHolds(freshness, lastSeen, fetchedAt)
    ? "unknown" : claimed;

  const hardware = machine.hardware && typeof machine.hardware === "object"
    ? machine.hardware : {};
  const memory = hardware.memory && typeof hardware.memory === "object"
    ? hardware.memory : {};
  const os = machine.os && typeof machine.os === "object" ? machine.os : {};

  return {
    id, name, platform, status, freshness,
    collectedAt: asTimestamp(machine.collectedAt),
    lastSeen,
    os: { name: asText(os.name), version: asText(os.version, 90) },
    hardware: {
      cpu: asText(hardware.cpu, 160),
      cpuCores: Number.isInteger(hardware.cpuCores) && hardware.cpuCores >= 0
        ? hardware.cpuCores : null,
      memoryTotalBytes: asBytes(memory.totalBytes),
      memoryFreeBytes: asBytes(memory.freeBytes),
    },
  };
}

export function projectFleetMachines(raw, fetchedAt = new Date().toISOString()) {
  if (!Array.isArray(raw) || raw.length > 300) {
    throw new TypeError("invalid_fleet_response");
  }
  const machines = raw.map((machine) => projectMachine(machine, fetchedAt));
  if (new Set(machines.map((machine) => machine.id)).size !== machines.length) {
    throw new TypeError("duplicate_fleet_machine");
  }
  return {
    schema: SCHEMA,
    source: "Velvet Fleet Console",
    fetchedAt,
    count: machines.length,
    machines,
  };
}
