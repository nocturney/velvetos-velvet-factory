import { selectCapabilities, selectDomain, selectIntegrations, selectRuntime, selectSources } from "./projection";
import { selectOfficePolicy } from "./office-projection";
import type { ControlCenterModuleDefinition } from "./types";
import { ActivityModule } from "./modules/ActivityModule";
import { AttentionModule } from "./modules/AttentionModule";
import { CapabilitiesModule } from "./modules/CapabilitiesModule";
import { JobsModule } from "./modules/JobsModule";
import { IntegrationsModule } from "./modules/IntegrationsModule";
import { RuntimeModule } from "./modules/RuntimeModule";
import { SourcesModule } from "./modules/SourcesModule";
import { SystemModule } from "./modules/SystemModule";
import { ToolsModule } from "./modules/ToolsModule";
import { OfficeDeskModule } from "./modules/OfficeDeskModule";
import { OfficePolicyModule } from "./modules/OfficePolicyModule";

const states = ["ready", "unavailable", "degraded", "needs_sync", "conflict", "unknown"] as const;
const base = { allowedCollectionStates: states, actions: [] as const, showProvenance: true, showFreshness: true };
const selector = (domain: string) => (snapshot: Parameters<typeof selectDomain>[0]) => selectDomain(snapshot, domain);
const capabilitySelector = (domains?: readonly string[]) => (snapshot: Parameters<typeof selectDomain>[0]) => selectCapabilities(snapshot, domains);
const visible = () => true;

export const moduleRegistry: ControlCenterModuleDefinition[] = [
  { ...base, id: "attention", title: "Owner Attention", domain: "attention", defaultView: "overview", views: ["overview", "office"], defaultSize: { cols: 5, rows: 3 }, priority: 100, visualRole: "primary", select: selector("attention"), isAvailable: visible, component: AttentionModule },
  { ...base, id: "jobs", title: "Sales & Jobs", domain: "jobs", defaultView: "overview", views: ["overview", "sales"], defaultSize: { cols: 7, rows: 3 }, priority: 95, visualRole: "operational", select: selector("jobs"), isAvailable: visible, component: JobsModule },
  { ...base, id: "activity", title: "Activity", domain: "activity", defaultView: "overview", views: ["overview", "studio"], defaultSize: { cols: 4, rows: 3 }, priority: 90, visualRole: "visual", select: selector("activity"), isAvailable: visible, component: ActivityModule },
  { ...base, id: "capabilities", title: "Capability Pulse", domain: "capabilities", defaultView: "overview", views: ["overview"], defaultSize: { cols: 8, rows: 3 }, priority: 80, visualRole: "system", select: selector("capabilities"), isAvailable: visible, component: CapabilitiesModule },
  { ...base, id: "system", title: "System Health", domain: "system", defaultView: "overview", views: ["overview"], defaultSize: { cols: 8, rows: 3 }, priority: 75, visualRole: "system", select: selector("system"), isAvailable: visible, component: SystemModule },

  { ...base, id: "studio-tools", title: "Studio & Production Tools", domain: "studio-tools", defaultView: "studio", views: ["studio"], defaultSize: { cols: 12, rows: 6 }, priority: 70, visualRole: "operational", select: capabilitySelector(["studio", "sku", "print", "calendar", "drive", "cost"]), isAvailable: visible, component: ToolsModule },
  { ...base, id: "sales-tools", title: "Sales & Finance Tools", domain: "sales-tools", defaultView: "sales", views: ["sales"], defaultSize: { cols: 9, rows: 6 }, priority: 70, visualRole: "operational", select: capabilitySelector(["gmail", "drive", "quote", "cost", "price", "books", "revenue", "pipeline", "timeline"]), isAvailable: visible, component: ToolsModule },
  { ...base, id: "media-tools", title: "Media & Growth Tools", domain: "media-tools", defaultView: "media", views: ["media"], defaultSize: { cols: 16, rows: 7 }, priority: 70, visualRole: "visual", select: capabilitySelector(["content", "instagram", "ig", "insights", "web", "boost", "paid"]), isAvailable: visible, component: ToolsModule },

  { ...base, id: "integrations", title: "Integration Registry", domain: "integrations", defaultView: "tools", views: ["tools"], defaultSize: { cols: 16, rows: 7 }, priority: 110, visualRole: "operational", select: selectIntegrations, isAvailable: visible, component: IntegrationsModule },
  { ...base, id: "tools-all", title: "Tool & Capability Matrix", domain: "capabilities", defaultView: "tools", views: ["tools"], defaultSize: { cols: 16, rows: 8 }, priority: 100, visualRole: "primary", select: capabilitySelector(), isAvailable: visible, component: ToolsModule },

  { ...base, id: "office-desk", title: "Office Specialist Roster", domain: "agents", defaultView: "office", views: ["office"], defaultSize: { cols: 10, rows: 6 }, priority: 100, visualRole: "operational", select: selector("agents"), isAvailable: visible, component: OfficeDeskModule },
  { ...base, id: "office-policy", title: "Office Policy & Source Map", domain: "office-policy", defaultView: "office", views: ["office"], defaultSize: { cols: 6, rows: 6 }, priority: 90, visualRole: "system", select: selectOfficePolicy, isAvailable: visible, component: OfficePolicyModule },

  { ...base, id: "sources", title: "Canonical Sources", domain: "collections", defaultView: "system", views: ["system"], defaultSize: { cols: 8, rows: 4 }, priority: 90, visualRole: "system", select: selectSources, isAvailable: visible, component: SourcesModule },
  { ...base, id: "runtime", title: "Runtime & Sensors", domain: "runtime", defaultView: "system", views: ["system"], defaultSize: { cols: 8, rows: 4 }, priority: 85, visualRole: "system", select: selectRuntime, isAvailable: visible, component: RuntimeModule },
  { ...base, id: "system-capabilities", title: "System Capabilities", domain: "system-capabilities", defaultView: "system", views: ["system"], defaultSize: { cols: 16, rows: 6 }, priority: 80, visualRole: "system", select: capabilitySelector(["memory", "office", "harness", "mem", "console", "instance", "public", "auto"]), isAvailable: visible, component: ToolsModule },
];
