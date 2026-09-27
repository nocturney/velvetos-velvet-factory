import type { ModuleSize, ViewId } from "./types";
import { moduleRegistry } from "./registry";

const KEY = "velvetos.control-center.layout.v1";

export interface LayoutPreferences {
  version: 1;
  activeView: ViewId;
  density: "wide" | "dense";
  hidden: string[];
  order: string[];
  sizes: Record<string, ModuleSize>;
}

const defaults = (): LayoutPreferences => ({
  version: 1,
  activeView: "overview",
  density: "wide",
  hidden: [],
  order: moduleRegistry.map((item) => item.id),
  sizes: Object.fromEntries(moduleRegistry.map((item) => [item.id, item.defaultSize])),
});

export function loadLayout(): LayoutPreferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const saved = JSON.parse(raw) as Partial<LayoutPreferences>;
    if (saved.version !== 1) return defaults();
    const known = new Set(moduleRegistry.map((item) => item.id));
    const order = [...(saved.order ?? []).filter((id) => known.has(id))];
    for (const item of moduleRegistry) if (!order.includes(item.id)) order.push(item.id);
    return { ...defaults(), ...saved, order, hidden: (saved.hidden ?? []).filter((id) => known.has(id)) };
  } catch {
    return defaults();
  }
}

export function saveLayout(value: LayoutPreferences) {
  localStorage.setItem(KEY, JSON.stringify(value));
}
