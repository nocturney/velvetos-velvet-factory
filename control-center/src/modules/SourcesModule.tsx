import type { ModuleProps } from "../types";
import { itemObject, ModuleFrame, text } from "./shared";

export function SourcesModule({ collection, definition }: ModuleProps) {
  const items = (collection.items ?? []).map(itemObject);
  return <ModuleFrame collection={collection} definition={definition}>
    <div className="source-grid">{items.map((item, index) =>
      <div className="source-card" key={text(item.id, String(index))}>
        <div className="source-head"><b>{text(item.id)}</b><span className={"source-state source-" + text(item.state)}>{text(item.state)}</span></div>
        <strong>{item.count === null || item.count === undefined ? "—" : text(item.count)}</strong>
        <span>{text(item.reason, item.state === "ready" ? "Canonical collection connected" : "No live projection available")}</span>
      </div>
    )}</div>
  </ModuleFrame>;
}
