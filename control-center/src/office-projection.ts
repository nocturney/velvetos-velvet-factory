import type { Collection, ControlSnapshot } from "./types";

// Office policy facts are a read-only subset of the canonical Core Control snapshot.
// A missing key is UNKNOWN; absence must never be silently presented as false/empty.
export function selectOfficePolicy(snapshot: ControlSnapshot | null): Collection {
  const unknown = (reason: string): Collection => ({
    state: "unknown", items: null, count: null, freshness: "unknown", reason,
  });
  if (!snapshot) return unknown("Control API snapshot not connected.");
  const flags = snapshot.flags && typeof snapshot.flags === "object"
    ? snapshot.flags as Record<string, unknown> : null;
  if (!flags) return unknown("Canonical Office control-plane flags not projected.");
  const system = flags.system && typeof flags.system === "object"
    ? flags.system as Record<string, unknown> : null;
  if (system?.state !== "ready") {
    return unknown("Office control-plane source is not verified ready.");
  }
  if (typeof flags.policyPresent !== "boolean" ||
      typeof flags.dontBotherChristian !== "boolean" ||
      !Array.isArray(flags.locks) ||
      !flags.locks.every((lock) => typeof lock === "string") ||
      !Number.isInteger(flags.sourcesOfTruthCount) ||
      (flags.sourcesOfTruthCount as number) < 0) {
    return unknown("Office policy flags incomplete or malformed.");
  }
  const source = system.provenance && typeof system.provenance === "object"
    ? system.provenance as Record<string, unknown> : null;
  return {
    state: "ready",
    items: [{
      policyPresent: flags.policyPresent,
      dontBotherChristian: flags.dontBotherChristian,
      lockCount: flags.locks.length,
      sourcesOfTruthCount: flags.sourcesOfTruthCount,
    }],
    count: 1,
    freshness: "unknown",
    provenance: source,
  };
}
