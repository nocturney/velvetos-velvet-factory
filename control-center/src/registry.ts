import { selectDomain } from "./projection";
import type { ControlCenterModuleDefinition } from "./types";
import { ActivityModule } from "./modules/ActivityModule";
import { AttentionModule } from "./modules/AttentionModule";
import { CapabilitiesModule } from "./modules/CapabilitiesModule";
import { JobsModule } from "./modules/JobsModule";
import { SystemModule } from "./modules/SystemModule";
import { FleetModule } from "./modules/FleetModule";

const states = ["ready", "unavailable", "degraded", "needs_sync", "conflict", "unknown"] as const;
const base = { allowedCollectionStates: states, actions: [] as const, showProvenance: true, showFreshness: true };
const selector = (domain: string) => (snapshot: Parameters<typeof selectDomain>[0]) => selectDomain(snapshot, domain);
const visible = () => true;

export const moduleRegistry: ControlCenterModuleDefinition[] = [
  { ...base, id: "attention", title: "Owner Attention", domain: "attention", defaultView: "overview", views: ["overview"], defaultSize: { cols: 5, rows: 3 }, priority: 100, visualRole: "primary", select: selector("attention"), isAvailable: visible, component: AttentionModule },
  { ...base, id: "jobs", title: "Sales & Jobs", domain: "jobs", defaultView: "overview", views: ["overview", "sales"], defaultSize: { cols: 7, rows: 3 }, priority: 90, visualRole: "operational", select: selector("jobs"), isAvailable: visible, component: JobsModule },
  { ...base, id: "activity", title: "Activity", domain: "activity", defaultView: "overview", views: ["overview", "studio"], defaultSize: { cols: 4, rows: 3 }, priority: 80, visualRole: "visual", select: selector("activity"), isAvailable: visible, component: ActivityModule },
  { ...base, id: "capabilities", title: "Capabilities", domain: "capabilities", defaultView: "system", views: ["overview", "system"], defaultSize: { cols: 8, rows: 3 }, priority: 70, visualRole: "system", select: selector("capabilities"), isAvailable: visible, component: CapabilitiesModule },
  { ...base, id: "system", title: "System Health", domain: "system", defaultView: "system", views: ["overview", "system"], defaultSize: { cols: 8, rows: 3 }, priority: 60, visualRole: "system", select: selector("system"), isAvailable: visible, component: SystemModule },
  { ...base, id: "fleet", title: "Fleet Machines", domain: "fleet", defaultView: "fleet", views: ["fleet"], defaultSize: { cols: 16, rows: 6 }, priority: 85, visualRole: "operational", select: () => ({ state: "unknown", items: null, reason: "Separate Fleet API, independently fetched" }), isAvailable: visible, component: FleetModule },
];
