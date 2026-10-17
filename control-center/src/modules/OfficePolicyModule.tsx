import type { ModuleProps } from "../types";
import { itemObject, ModuleFrame, text } from "./shared";

export function OfficePolicyModule({ collection, definition }: ModuleProps) {
  const verified = collection.state === "ready" && Array.isArray(collection.items) && collection.items.length === 1;
  const item = verified ? itemObject(collection.items![0]) : {};
  return <ModuleFrame collection={collection} definition={definition}>
    <div className="metric-strip three">
      <div><span>Policy file</span><strong>{verified ? (item.policyPresent ? "Present" : "Missing") : "—"}</strong></div>
      <div><span>Owner protection</span><strong>{verified ? (item.dontBotherChristian ? "On" : "Off") : "—"}</strong></div>
      <div><span>Declared sources</span><strong>{verified ? text(item.sourcesOfTruthCount) : "—"}</strong></div>
    </div>
    <div className="rows">
      <div className="row"><span>Configured control-plane locks</span><b>{verified ? text(item.lockCount) : "—"}</b></div>
    </div>
    <div className="truth-banner"><b>Read-only configuration facts</b>
      <span>Presence of a policy file or configured locks does not demonstrate enforcement, live approvals or active leases. No write controls are available in this view.</span>
    </div>
  </ModuleFrame>;
}
