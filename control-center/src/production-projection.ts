import type { Collection } from "./types";
import { itemObject } from "./modules/shared";

export type ProductionRows = {
  verified: boolean;
  printers: Record<string, unknown>[] | null;
  events: Record<string, unknown>[] | null;
  printerCount: number | null;
  eventCount: number | null;
  maintenanceCount: number | null;
  materialCount: number | null;
};
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;

export function selectProductionRows(collection: Collection): ProductionRows {
  const invalid: ProductionRows = {
    verified: false, printers: null, events: null, printerCount: null,
    eventCount: null, maintenanceCount: null, materialCount: null,
  };
  if (collection.state !== "ready" || !Array.isArray(collection.items)) return invalid;
  const rows = collection.items.map(itemObject);
  const printers = rows.filter((row) => row.kind === "printer");
  const events = rows.filter((row) => row.kind === "print_event");
  return {
    verified: true, printers, events,
    printerCount: count(collection.printerCount) ?? printers.length,
    eventCount: count(collection.eventCount) ?? events.length,
    maintenanceCount: count(collection.maintenanceCount),
    materialCount: Array.isArray(collection.materials) ? collection.materials.length : null,
  };
}
