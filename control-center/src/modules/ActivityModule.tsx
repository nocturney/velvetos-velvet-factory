import type { ModuleProps } from "../types";
import { itemObject, ModuleFrame, text } from "./shared";

export function ActivityModule({ collection, definition }: ModuleProps) {
  return <ModuleFrame collection={collection} definition={definition}>
    <div className="timeline">{(collection.items ?? []).slice(0, 5).map((value, i) => {
      const item = itemObject(value);
      return <div className="timeline-row" key={i}>
        <span className="timeline-dot"></span>
        <div><b>{text(item.title ?? item.type)}</b><span>{text(item.status ?? item.type)}</span></div>
      </div>;
    })}</div>
  </ModuleFrame>;
}
