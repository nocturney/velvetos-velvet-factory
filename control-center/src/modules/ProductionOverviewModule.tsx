import type { ModuleProps } from "../types";
import { EmptyTruth, ModuleFrame, text } from "./shared";
import { selectProductionRows } from "../production-projection";

export function ProductionOverviewModule({ collection, definition }: ModuleProps) {
  const data = selectProductionRows(collection);
  return <ModuleFrame collection={collection} definition={definition}>
    <div className="metric-strip three">
      <div><span>Configured printers</span><strong>{data.verified ? text(data.printerCount) : "—"}</strong></div>
      <div><span>Recorded print events</span><strong>{data.verified ? text(data.eventCount) : "—"}</strong></div>
      <div><span>Maintenance entries</span><strong>{data.verified ? text(data.maintenanceCount) : "—"}</strong></div>
    </div>
    {data.verified && data.printers!.length === 0 &&
      <EmptyTruth title="No printers in the verified projection" detail="Source-reported inventory, not a live network scan." />}
    {data.verified && data.printers!.length > 0 && <div className="rows">
      {data.printers!.slice(0, 8).map((printer, i) =>
        <div className="row row-rich" key={text(printer.id, String(i))}>
          <div><b>{text(printer.brand)} {text(printer.model)}</b>
            <span>ID: {text(printer.id)} · Source status: {text(printer.status, "unknown")}</span></div>
          <small>{text(printer.enclosure)}</small>
        </div>)}
    </div>}
    {data.verified && data.events!.length > 0 && <>
      <div className="truth-banner"><b>Recorded print events</b><span>Events come from the canonical source log; this is not a live printer telemetry feed.</span></div>
      <div className="rows">{data.events!.slice(-5).reverse().map((event, i) =>
        <div className="row row-rich" key={text(event.id, String(i))}>
          <div><b>{text(event.productName ?? event.sku ?? event.name ?? event.id)}</b><span>{text(event.producedAt)} · {text(event.printer)}</span></div>
          <small>{text(event.status, "unknown")}</small>
        </div>)}</div>
    </>}
    <div className="truth-banner"><b>Read-only source projection</b>
      <span>Printer status, materials and events are source-reported configuration/history. Current connection, actual print progress and Watchtower telemetry require a separately verified live adapter.</span>
    </div>
  </ModuleFrame>;
}
