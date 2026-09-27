import type { ModuleProps } from "../types";
import { itemObject, ModuleFrame, text } from "./shared";

export function SystemModule({ collection, definition }: ModuleProps) {
  const system = itemObject(collection.items?.[0]);
  const provenance = collection.provenance ?? {};
  return <ModuleFrame collection={collection} definition={definition}>
    <div className="system-grid">
      <div className="system-gauge"><span className={"health-ring " + (collection.state === "ready" ? "ok" : "")}></span><div><span>Projection</span><strong>{collection.state}</strong></div></div>
      <div><span>Authority</span><b>{text(provenance.authority)}</b></div>
      <div><span>Verified</span><b>{text(provenance.verifiedAt)}</b></div>
      <div><span>Source</span><b>{text(provenance.source ?? system.source)}</b></div>
    </div>
  </ModuleFrame>;
}
