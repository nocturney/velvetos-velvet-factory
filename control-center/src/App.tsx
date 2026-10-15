import { useEffect, useMemo, useState } from "react";
import { useControlSnapshot } from "./useControlSnapshot";
import { evaluateSnapshotHealth } from "./snapshot-health";
import { moduleRegistry } from "./registry";
import { loadLayout, saveLayout } from "./layout";
import { CommandPalette } from "./CommandPalette";
import { ModuleErrorBoundary } from "./ModuleErrorBoundary";
import type { ViewId } from "./types";

const views: { id: ViewId; label: string }[] = [
  { id: "overview", label: "Overview" }, { id: "studio", label: "Studio" },
  { id: "sales", label: "Sales" }, { id: "media", label: "Media" },
  { id: "tools", label: "Tools" }, { id: "office", label: "Office" }, { id: "system", label: "System" }, { id: "fleet", label: "Fleet" },
];

export default function App() {
  const { snapshot, error, now } = useControlSnapshot();
  const [layout, setLayout] = useState(loadLayout);
  const [palette, setPalette] = useState(false);

  useEffect(() => saveLayout(layout), [layout]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPalette(true); } if (event.key === "Escape") setPalette(false); };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);

  const modules = useMemo(() => layout.order.map((id) => moduleRegistry.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m) && !layout.hidden.includes(m!.id))
    .filter((m) => m.views.includes(layout.activeView) && m.isAvailable(snapshot)), [layout, snapshot]);

  const flags = (snapshot?.flags ?? {}) as Record<string, unknown>;
  const snapshotHealth = evaluateSnapshotHealth(snapshot, now);
  const freshness = snapshotHealth;
  const displayState = error ? "DISCONNECTED" : !snapshot ? "CONNECTING" :
    snapshotHealth === "live" ? "LIVE VERIFIED" :
    snapshotHealth === "fresh" ? "FRESH SNAPSHOT" :
    snapshotHealth === "stale" ? "STALE SNAPSHOT" :
    snapshotHealth === "disconnected" ? "DISCONNECTED" : "UNKNOWN";
  const health = String(flags.velvetosHealth ?? "unknown");

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><div className="mark">V</div><div><b>VelvetOS</b><span>Control Center</span></div></div>
      <button className="search-trigger" onClick={() => setPalette(true)}><span>⌕</span><b>Search / Command</b><kbd>Ctrl K</kbd></button>
      <div className="top-actions"><span className={`live-dot ${!error && (snapshotHealth === "live" || snapshotHealth === "fresh") ? "online" : ""}`}></span><small>{displayState}</small>
        <button onClick={() => setLayout((x) => ({ ...x, density: x.density === "wide" ? "dense" : "wide" }))}>{layout.density === "wide" ? "Wide" : "Dense"}</button></div>
    </header>
    <nav>{views.map((view) => <button key={view.id} className={layout.activeView === view.id ? "active" : ""} onClick={() => setLayout((x) => ({ ...x, activeView: view.id }))}>{view.label}</button>)}</nav>
    <main><section className="aurora-hero"><div className="hero-copy"><span className="eyebrow">OWNER OPERATING SURFACE</span><h1>מרכז השליטה של VelvetOS</h1><p>תמונה אחת של מצב העסק והמערכת — עם אמת תפעולית, מקוריות נתונים ופעולות שנשארות fail‑closed.</p></div>
      <div className="hero-status"><div><span>Health</span><b>{health}</b></div><div><span>Freshness</span><b>{freshness}</b></div><div><span>Mode</span><b>Read only</b></div></div></section>
      {error && <div className="connection-warning"><b>Read-only shell active</b><span>{error} לא מוצגים מספרי demo במקום אמת.</span></div>}
      <section className={`board ${layout.density}`}>{modules.map((definition) => {
        const Module = definition.component;
        return <div className="slot" key={definition.id} style={{ gridColumn: `span ${definition.defaultSize.cols}`, gridRow: `span ${definition.defaultSize.rows}` }}>
          <ModuleErrorBoundary moduleId={definition.id}>
            <Module definition={definition} collection={definition.select(snapshot)} />
          </ModuleErrorBoundary>
        </div>;
      })}</section>
    </main>
    <CommandPalette open={palette} onClose={() => setPalette(false)} />
  </div>;
}
