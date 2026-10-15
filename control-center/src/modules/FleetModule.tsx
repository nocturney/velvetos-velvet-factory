import { useEffect, useState } from "react";
import { getFleetMachines, type FleetMachinesSnapshot } from "../fleet-api";
import type { ModuleProps } from "../types";
import { ModuleFrame } from "./shared";

function gib(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? (value / (1024 ** 3)).toFixed(1) + " GiB" : "לא ידוע";
}

function date(value: string | null): string {
  if (!value) return "לא ידוע";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "לא ידוע" : parsed.toLocaleString("he-IL");
}

export function FleetModule({ definition }: ModuleProps) {
  const [snapshot, setSnapshot] = useState<FleetMachinesSnapshot | null>(null);
  const [error, setError] = useState("טוען נתונים מ־Fleet...");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await getFleetMachines(controller.signal);
        if (!active) return;
        setSnapshot(data);
        setError("");
      } catch (reason) {
        if (!active) return;
        // Never retain a prior read as apparently current after a failed refresh.
        setSnapshot(null);
        setError(reason instanceof Error ? reason.message : "מקור Fleet לא זמין");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, []);

  const collection = {
    state: snapshot ? "ready" as const : "unavailable" as const,
    freshness: snapshot ? "fresh" as const : "unknown" as const,
    items: snapshot?.machines ?? null,
    reason: snapshot ? null : error,
    provenance: {
      source: snapshot?.source ?? "Velvet Fleet Console",
      verifiedAt: snapshot?.fetchedAt,
      freshness: snapshot ? "fleet_snapshot" : "unknown",
    },
  };

  return <ModuleFrame collection={collection} definition={definition}>
    <div dir="rtl">
      <div className="row">
        <b>מחשבים הרשומים ב־Fleet: {snapshot ? snapshot.count : "—"}</b>
        <span>{snapshot ? "נשלף: " + date(snapshot.fetchedAt) : (loading ? "טוען..." : "מנותק")}</span>
      </div>
      <p>רשימת מחשבים מה־Fleet Console הקיים. מצב וזמינות הם נתוני המקור; זו אינה טלמטריית CPU בזמן אמת.</p>
      {snapshot?.machines.length === 0 && <div className="quiet-state">אין מחשבים רשומים ב־Fleet.</div>}
      {snapshot?.machines.map((machine) => <div className="row row-rich" key={machine.id}>
        <div>
          <b>{machine.name}</b>
          <span>{machine.platform} · {machine.os.name || "מערכת לא ידועה"} · {machine.os.version || "גרסה לא ידועה"}</span>
          <span>מעבד: {machine.hardware.cpu || "לא ידוע"} · זיכרון כולל: {gib(machine.hardware.memoryTotalBytes)}</span>
        </div>
        <div>
          <b>{machine.status === "online" ? "מדווח כמחובר" : machine.status === "offline" ? "מדווח כמנותק" : "מצב לא ידוע"}</b>
          <span>עדכניות: {machine.freshness} · איסוף: {date(machine.collectedAt)}</span>
          <span>דיווח אחרון: {date(machine.lastSeen)}</span>
        </div>
      </div>)}
    </div>
  </ModuleFrame>;
}
