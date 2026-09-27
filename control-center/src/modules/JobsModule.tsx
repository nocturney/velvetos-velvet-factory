import type { ModuleProps } from "../types";
import { EmptyTruth, itemObject, ModuleFrame, text } from "./shared";

export function JobsModule({ collection, definition }: ModuleProps) {
  const items = collection.items ?? [];
  const truthfullyEmpty = collection.state === "ready" && items.length === 0;
  return <ModuleFrame collection={collection} definition={definition}>
    <div className="metric-strip three">
      <div><span>עבודות פעילות</span><strong>{collection.state === "ready" ? text(collection.count ?? items.length, "0") : "—"}</strong></div>
      <div><span>מצב</span><strong>{collection.state}</strong></div>
      <div><span>טריות</span><strong>{text(collection.provenance?.freshness ?? collection.freshness)}</strong></div>
    </div>
    {truthfullyEmpty && <EmptyTruth title="אין עבודות פעילות במקור המאומת" detail="הכרטיס נשאר מחובר ל־SoT ולא ממלא נתוני demo." />}
    {collection.state === "ready" && items.length > 0 && <div className="rows">{items.slice(0, 5).map((value, i) => {
      const item = itemObject(value);
      return <div className="row row-rich" key={i}><div><b>{text(item.title ?? item.name ?? item.id)}</b><span>{text(item.customer ?? item.nextAction ?? item.status)}</span></div><small>{text(item.status, "")}</small></div>;
    })}</div>}
  </ModuleFrame>;
}
