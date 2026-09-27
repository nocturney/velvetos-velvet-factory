import type { ModuleProps } from "../types";
import { itemObject, ModuleFrame, text } from "./shared";

export function CapabilitiesModule({ collection, definition }: ModuleProps) {
  const items = (collection.items ?? []).map(itemObject);
  const available = items.filter((item) => text(item.status).toUpperCase() === "AVAILABLE").length;
  const domains = new Set(items.map((item) => text(item.domain)).filter((value) => value !== "—")).size;
  return <ModuleFrame collection={collection} definition={definition}>
    <div className="metric-strip three">
      <div><span>יכולות</span><strong>{items.length}</strong></div>
      <div><span>זמינות</span><strong>{available}</strong></div>
      <div><span>דומיינים</span><strong>{domains}</strong></div>
    </div>
    <div className="capability-cloud">{items.slice(0, 12).map((item, i) =>
      <span key={i}>{text(item.id ?? item.label)}</span>)}</div>
  </ModuleFrame>;
}
