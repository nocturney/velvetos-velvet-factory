import type { ModuleProps } from "../types";
import { EmptyTruth, itemObject, ModuleFrame, text } from "./shared";

export function ModelShelfModule({ collection, definition }: ModuleProps) {
  const verified = collection.state === "ready" && Array.isArray(collection.items);
  const slots = verified ? collection.items! : [];
  return <ModuleFrame collection={collection} definition={definition}>
    <div className="metric-strip three">
      <div><span>Occupied slots</span><strong>{verified ? text(collection.occupiedCount) : "—"}</strong></div>
      <div><span>Source-ready slots</span><strong>{verified ? text(collection.readyCount) : "—"}</strong></div>
      <div><span>Shelf capacity</span><strong>{verified ? text(collection.maxSlots) : "—"}</strong></div>
    </div>
    {verified && slots.length === 0 &&
      <EmptyTruth title="Verified empty model shelf" detail="No model slots in the canonical shelf projection." />}
    {verified && slots.length > 0 && <div className="rows">{slots.slice(0, 8).map((raw, i) => {
      const slot = itemObject(raw);
      return <div className="row row-rich" key={text(slot.id, String(i))}>
        <div><b>{text(slot.name ?? slot.id)}</b>
          <span>Source status: {text(slot.status)} · Material: {text(slot.material)}</span></div>
        <small>{text(slot.licenseChecked)}</small>
      </div>;
    })}</div>}
    <div className="truth-banner"><b>Model shelf · not a production order</b>
      <span>Readiness and license-check flags are copied from the canonical shelf. They do not mean a printer has accepted or started a job.</span>
    </div>
  </ModuleFrame>;
}
