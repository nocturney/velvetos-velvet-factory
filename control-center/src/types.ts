import type { ComponentType } from "react";

export type CollectionState =
  | "ready" | "unavailable" | "degraded" | "needs_sync" | "conflict" | "unknown";
export type Freshness = "live" | "fresh" | "stale" | "unknown";
export type VisualRole = "primary" | "operational" | "visual" | "system" | "assistant";
export type ViewId = "overview" | "studio" | "production" | "sales" | "media" | "tools" | "office" | "system" | "fleet";

export interface Collection<T = unknown> {
  state: CollectionState;
  freshness?: Freshness;
  items: T[] | null;
  count?: number | null;
  reason?: string | null;
  provenance?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ControlSnapshot {
  schema: "velvetos.control.v1" | string;
  generatedAt?: string;
  [key: string]: unknown;
}

export interface SearchResult {
  id?: string; title?: string; subtitle?: string; destination?: string; domain?: string;
  [key: string]: unknown;
}

export interface ModuleSize { cols: number; rows: number; }
export interface ModuleProps { collection: Collection; definition: ControlCenterModuleDefinition; }

export interface ControlCenterModuleDefinition {
  id: string; title: string; domain: string;
  defaultView: ViewId; views: readonly ViewId[];
  defaultSize: ModuleSize; minSize?: ModuleSize; maxSize?: ModuleSize;
  priority: number; visualRole: VisualRole;
  allowedCollectionStates: readonly CollectionState[];
  actions: readonly string[];
  showProvenance: boolean; showFreshness: boolean;
  select: (snapshot: ControlSnapshot | null) => Collection;
  isAvailable: (snapshot: ControlSnapshot | null) => boolean;
  component: ComponentType<ModuleProps>;
}
