import type { ModuleProps } from "../types";
import { EmptyTruth, itemObject, ModuleFrame, text } from "./shared";

export function OfficeDeskModule({ collection, definition }: ModuleProps) {
  const verified = collection.state === "ready" && Array.isArray(collection.items);
  const specialists = verified ? collection.items! : [];
  return <ModuleFrame collection={collection} definition={definition}>
    <div className="metric-strip three">
      <div><span>Desk specialists</span><strong>{verified ? text(collection.count ?? specialists.length) : "—"}</strong></div>
      <div><span>Office seats</span><strong>{verified ? text(collection.seatCount) : "—"}</strong></div>
      <div><span>Source state</span><strong>{collection.state}</strong></div>
    </div>
    {verified && specialists.length === 0 &&
      <EmptyTruth title="Verified empty desk roster" detail="Core projected zero desk specialists." />}
    {verified && specialists.length > 0 && <div className="rows">
      {specialists.slice(0, 8).map((raw, index) => {
        const specialist = itemObject(raw);
        return <div className="row row-rich" key={text(specialist.id, String(index))}>
          <div><b>{text(specialist.id)}</b><span>{text(specialist.job, "No job description projected")}</span></div>
          <small>{text(specialist.seat, "Seat unknown")}</small>
        </div>;
      })}
    </div>}
    <div className="truth-banner"><b>Configuration roster · read-only</b>
      <span>A registered desk specialist does not prove a worker is currently executing, leased or online. Task and approval receipts require their own canonical source.</span>
    </div>
  </ModuleFrame>;
}
