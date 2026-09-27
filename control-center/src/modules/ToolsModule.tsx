import type { ModuleProps } from "../types";
import { itemObject, ModuleFrame, text } from "./shared";

const statusOrder = ["AVAILABLE", "APPROVAL_REQUIRED", "UNAVAILABLE", "BLOCKED"];

export function ToolsModule({ collection, definition }: ModuleProps) {
  const items = (collection.items ?? []).map(itemObject);
  const domains = new Set(items.map((item) => text(item.domain)).filter((value) => value !== "—"));
  const counts = Object.fromEntries(statusOrder.map((status) => [
    status,
    items.filter((item) => text(item.status).toUpperCase() === status).length,
  ]));

  return <ModuleFrame collection={collection} definition={definition}>
    <div className="tool-summary">
      <div><span>Capabilities</span><strong>{items.length}</strong></div>
      <div><span>Domains</span><strong>{domains.size}</strong></div>
      <div className="good"><span>Available</span><strong>{counts.AVAILABLE}</strong></div>
      <div className="warn"><span>Approval</span><strong>{counts.APPROVAL_REQUIRED}</strong></div>
      <div className="bad"><span>Blocked / unavailable</span><strong>{counts.BLOCKED + counts.UNAVAILABLE}</strong></div>
    </div>
    <div className="tool-list">
      {items.map((item, index) => <div className="tool-row" key={text(item.id, String(index))}>
        <div className="tool-main">
          <b>{text(item.label ?? item.id)}</b>
          <span>{text(item.domain)} · {text(item.provider, "policy / internal")}</span>
        </div>
        <div className={"tool-status tool-" + text(item.status, "unknown").toLowerCase()}>
          {text(item.status)}
        </div>
      </div>)}
    </div>
  </ModuleFrame>;
}
