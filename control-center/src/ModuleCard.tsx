import type { Collection, ControlCenterModuleDefinition } from "./types";

function stateLabel(state: string) {
  return state.replace("_", " ").toUpperCase();
}

function rows(collection?: Collection | Record<string, unknown> | null) {
  if (!collection) return [];
  const value = (collection as Collection).items;
  return Array.isArray(value) ? value.slice(0, 5) : [];
}

function line(item: unknown, index: number) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return `Item ${index + 1}`;
  const row = item as Record<string, unknown>;
  return String(row.title ?? row.name ?? row.label ?? row.id ?? row.status ?? `Item ${index + 1}`);
}

export function ModuleCard({ definition, collection }: {
  definition: ControlCenterModuleDefinition;
  collection?: Collection | Record<string, unknown> | null;
}) {
  const state = String((collection as Collection | undefined)?.state ?? "unknown");
  const freshness = String((collection as Collection | undefined)?.freshness ?? "unknown");
  const items = rows(collection);
  const reason = (collection as Collection | undefined)?.reason;

  return <section className={`module role-${definition.visualRole}`}>
    <header><div><strong>{definition.title}</strong><span>{definition.domain}</span></div>
      <div className={`state state-${state}`}>{stateLabel(state)}</div></header>
    <div className="module-body">
      {state !== "ready" && <div className="truth-banner"><b>{stateLabel(state)}</b><span>{String(reason ?? "No verified live collection is available.")}</span></div>}
      {items.length > 0 ? <div className="rows">{items.map((item, i) =>
        <div className="row" key={i}><span>{line(item, i)}</span><small>{typeof item === "object" && item ? String((item as Record<string, unknown>).status ?? "") : ""}</small></div>
      )}</div> : state === "ready" ? <div className="empty">אין פריטים מאומתים להצגה כרגע.</div> : null}
    </div>
    <footer><span>freshness: {freshness}</span>{definition.showProvenance && <span>source details available</span>}</footer>
  </section>;
}
