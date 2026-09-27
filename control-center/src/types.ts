export type CollectionState =
  | "ready" | "unavailable" | "degraded" | "needs_sync" | "conflict" | "unknown";

export type Freshness = "live" | "fresh" | "stale" | "unknown";
export type VisualRole = "primary" | "operational" | "visual" | "system" | "assistant";
export type ViewId = "overview" | "studio" | "sales" | "media" | "system";

export interface Collection<T = unknown> {
  state: CollectionState;
  freshness?: Freshness;
  items: T[] | null;
  reason?: string | null;
  provenance?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ControlSnapshot {
  schema: "velvetos.control.v1" | string;
  generatedAt?: string;
  domains?: Record<string, Collection | Record<string, unknown> | null>;
  [key: string]: unknown;
}

export interface SearchResult {
  id?: string;
  title?: string;
  subtitle?: string;
  destination?: string;
  domain?: string;
  [key: string]: unknown;
}

export interface ModuleSize { cols: number; rows: number; }

export interface ControlCenterModuleDefinition {
  id: string;
  title: string;
  domain: string;
  defaultView: ViewId;
  views: readonly ViewId[];
  defaultSize: ModuleSize;
  minSize?: ModuleSize;
  maxSize?: ModuleSize;
  priority: number;
  visualRole: VisualRole;
  allowedCollectionStates: readonly CollectionState[];
  actions: readonly string[];
  showProvenance: boolean;
  showFreshness: boolean;
}

