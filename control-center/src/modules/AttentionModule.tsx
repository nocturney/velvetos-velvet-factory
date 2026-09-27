import type { ModuleProps } from "../types";
import { itemObject, ModuleFrame, text } from "./shared";

export function AttentionModule({ collection, definition }: ModuleProps) {
  const items = collection.items ?? [];
  return <ModuleFrame collection={collection} definition={definition}>
    <div className="metric-strip">
      <div><span>דורש תשומת לב</span><strong>{items.length}</strong></div>
      <div><span>מצב מקור</span><strong>{collection.state}</strong></div>
    </div>
    <div className="rows">{items.slice(0, 4).map((value, i) => {
      const item = itemObject(value);
      return <div className="row row-rich" key={i}>
        <div><b>{text(item.title ?? item.id)}</b><span>{text(item.waitingFor ?? item.nextAction, "ללא חסם")}</span></div>
        <small className={"risk risk-" + text(item.risk, "NA").toLowerCase()}>{text(item.risk, "")}</small>
      </div>;
    })}</div>
  </ModuleFrame>;
}
