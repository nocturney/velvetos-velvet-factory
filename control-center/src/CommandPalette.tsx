import { useEffect, useLayoutEffect, useState } from "react";
import { controlApi } from "./control-api";
import type { SearchResult } from "./types";

export type PaletteSearch = (query: string, signal: AbortSignal) => Promise<SearchResult[]>;
export interface PaletteSearchHandlers {
  onStart: () => void;
  onResults: (items: SearchResult[]) => void;
  onError: () => void;
}

// One debounced search per effect run. Cleanup cancels the timer, aborts the in-flight
// request and silences its callbacks, so a superseded or closed search can never write.
export function scheduleSearch(query: string, search: PaletteSearch, handlers: PaletteSearchHandlers, delayMs = 180): () => void {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    handlers.onStart();
    search(query, controller.signal).then((items) => {
      if (!controller.signal.aborted) handlers.onResults(items);
    }).catch(() => {
      if (!controller.signal.aborted) handlers.onError();
    });
  }, delayMs);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState("");

  // Layout effect: the reset commits before the browser paints, so results from a previous
  // query or session can never show for a frame after a query change, close or reopen.
  useLayoutEffect(() => {
    setResults([]);
    setStatus("");
  }, [open, query]);

  useEffect(() => {
    if (!open || query.trim().length < 2) return;
    return scheduleSearch(query, (q, signal) => controlApi.search(q, signal), {
      onStart: () => setStatus("מחפש…"),
      onResults: (items) => {
        setResults(items);
        setStatus(items.length ? "" : "לא נמצאו תוצאות מאומתות");
      },
      onError: () => setStatus("החיפוש אינו זמין כרגע"),
    });
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
