import { useEffect, useState } from "react";
import { controlApi } from "./control-api";
import type { SearchResult } from "./types";

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!open || query.trim().length < 2) { setResults([]); setStatus(""); return; }
    const timer = window.setTimeout(() => {
      setStatus("מחפש…");
      controlApi.search(query).then((items) => {
        setResults(items);
        setStatus(items.length ? "" : "לא נמצאו תוצאות מאומתות");
      }).catch(() => setStatus("החיפוש אינו זמין כרגע"));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  if (!open) return null;
  return <div className="palette-backdrop" onMouseDown={onClose}>
    <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
      <div className="palette-top"><span>⌘K</span><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="חיפוש ב‑VelvetOS…" /></div>
      <div className="palette-results">{status && <div className="empty">{status}</div>}
        {results.map((item, i) => <button key={i} onClick={onClose}><b>{item.title ?? item.id ?? "Result"}</b><span>{item.subtitle ?? item.domain ?? item.destination ?? ""}</span></button>)}
      </div>
      <div className="palette-foot">Search only · no arbitrary commands</div>
    </div>
  </div>;
}
