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

export function projectMachine(machine) {
  if (!machine || typeof machine !== "object" || Array.isArray(machine)) {
    throw new TypeError("invalid_fleet_machine");
  }
  const id = asText(machine.id, 128);
  const name = asText(machine.name, 120);
  if (!id || !name) throw new TypeError("invalid_fleet_identity");

  const platform = ["windows", "macos", "linux"].includes(machine.platform)
    ? machine.platform : "unknown";
  const status = ["online", "offline", "unknown"].includes(machine.status)
    ? machine.status : "unknown";
  const freshness = ["live", "stale", "unknown"].includes(machine.freshness)
    ? machine.freshness : "unknown";

  const hardware = machine.hardware && typeof machine.hardware === "object"
    ? machine.hardware : {};
  const memory = hardware.memory && typeof hardware.memory === "object"
    ? hardware.memory : {};
  const os = machine.os && typeof machine.os === "object" ? machine.os : {};

  return {
    id, name, platform, status, freshness,
    collectedAt: asTimestamp(machine.collectedAt),
    lastSeen: asTimestamp(machine.lastSeen),
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
  const machines = raw.map(projectMachine);
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
