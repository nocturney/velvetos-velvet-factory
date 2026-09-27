import type { ModuleProps } from "../types";
import { itemObject, ModuleFrame, text } from "./shared";

export function RuntimeModule({ collection, definition }: ModuleProps) {
  const items = (collection.items ?? []).map(itemObject);
  return <ModuleFrame collection={collection} definition={definition}>
    <div className="runtime-list">{items.map((item, index) =>
      <div className="runtime-row" key={text(item.id, String(index))}>
        <span className={"runtime-dot " + (text(item.status) === "ok" ? "ok" : "")}></span>
        <div><b>{text(item.label ?? item.id)}</b><span>{text(item.detail ?? item.status ?? item.kind)}</span></div>
        <small>{text(item.kind)}</small>
      </div>
    )}</div>
  </ModuleFrame>;
}
