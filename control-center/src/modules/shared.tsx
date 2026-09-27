import type { PropsWithChildren } from "react";
import type { Collection, ModuleProps } from "../types";

export const text = (value: unknown, fallback = "—") =>
  value === null || value === undefined || value === "" ? fallback : String(value);

export function itemObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function ModuleFrame({ collection, definition, children }: PropsWithChildren<ModuleProps>) {
  const state = text(collection.state, "unknown");
  const freshness = text(collection.provenance?.freshness ?? collection.freshness, "unknown");
  return <section className={"module role-" + definition.visualRole}>
    <header>
      <div><strong>{definition.title}</strong><span>{definition.domain}</span></div>
      <div className={"state state-" + state}>{state.replace("_", " ").toUpperCase()}</div>
    </header>
    <div className="module-body">
      {state !== "ready" && <div className="truth-banner">
        <b>{state.toUpperCase()}</b>
        <span>{text(collection.reason, "No verified live collection is available.")}</span>
      </div>}
      {children}
    </div>
    <footer>
      <span>{definition.showFreshness ? "freshness: " + freshness : ""}</span>
      <span>{definition.showProvenance ? "provenance bound" : ""}</span>
    </footer>
  </section>;
}

export function EmptyTruth({ title, detail }: { title: string; detail: string }) {
  return <div className="quiet-state">
    <span className="quiet-orb"></span>
    <div><b>{title}</b><span>{detail}</span></div>
  </div>;
}
