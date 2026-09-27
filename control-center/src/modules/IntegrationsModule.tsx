import type { ModuleProps } from "../types";
import { itemObject, ModuleFrame, text } from "./shared";

function statusClass(status: string) {
  return "integration-" + status.toLowerCase();
}

export function IntegrationsModule({ collection, definition }: ModuleProps) {
  const items = (collection.items ?? []).map(itemObject);
  const available = items.filter((item) => text(item.status).toUpperCase() === "AVAILABLE").length;
  const needsAuth = items.filter((item) => text(item.status).toUpperCase() === "NEEDS_AUTH").length;
  const unavailable = items.filter((item) => ["UNAVAILABLE", "BLOCKED"].includes(text(item.status).toUpperCase())).length;

  return <ModuleFrame collection={collection} definition={definition}>
    <div className="integration-summary">
      <div><span>Integrations</span><strong>{items.length}</strong></div>
      <div className="good"><span>Available</span><strong>{available}</strong></div>
      <div className="warn"><span>Needs auth</span><strong>{needsAuth}</strong></div>
      <div className="bad"><span>Unavailable / blocked</span><strong>{unavailable}</strong></div>
    </div>
    <div className="integration-grid">
      {items.map((item, index) => {
        const status = text(item.status, "UNAVAILABLE");
        return <div className="integration-card" key={text(item.id, String(index))}>
          <div className="integration-card-head">
            <div><b>{text(item.label ?? item.id)}</b><span>{text(item.namespace, text(item.id))}</span></div>
            <span className={"integration-status " + statusClass(status)}>{status}</span>
          </div>
          <div className="integration-meta">
            <span>{text(item.mode, text(item.sourceStatus, "configured"))}</span>
            <span>{text(item.useWhen, "No usage note")}</span>
          </div>
        </div>;
      })}
    </div>
  </ModuleFrame>;
}
