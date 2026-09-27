import type { ControlCenterModuleDefinition } from "./types";

const common = {
  allowedCollectionStates: ["ready", "unavailable", "degraded", "needs_sync", "conflict", "unknown"] as const,
  actions: [] as string[],
  showProvenance: true,
  showFreshness: true,
};

export const moduleRegistry: ControlCenterModuleDefinition[] = [
  { ...common, id: "attention", title: "Owner Attention", domain: "attention", defaultView: "overview", views: ["overview"], defaultSize: { cols: 5, rows: 4 }, priority: 100, visualRole: "primary" },
  { ...common, id: "jobs", title: "Sales & Jobs", domain: "jobs", defaultView: "overview", views: ["overview", "sales"], defaultSize: { cols: 7, rows: 4 }, priority: 90, visualRole: "operational" },
  { ...common, id: "activity", title: "Activity", domain: "activity", defaultView: "overview", views: ["overview", "studio"], defaultSize: { cols: 4, rows: 4 }, priority: 80, visualRole: "visual" },
  { ...common, id: "capabilities", title: "Capabilities", domain: "capabilities", defaultView: "system", views: ["overview", "system"], defaultSize: { cols: 8, rows: 3 }, priority: 70, visualRole: "system" },
  { ...common, id: "system", title: "System Health", domain: "system", defaultView: "system", views: ["overview", "system"], defaultSize: { cols: 8, rows: 3 }, priority: 60, visualRole: "system" },
];
