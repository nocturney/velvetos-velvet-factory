import { useEffect, useState } from "react";
import { displayableFleetSnapshot, getFleetMachines, type FleetMachinesSnapshot } from "../fleet-api";
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
  const [loadedSnapshot, setSnapshot] = useState<FleetMachinesSnapshot | null>(null);
  const [, forceExpiryCheck] = useState(0);
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

  // A successful GET is only valid until its signed deadline, not until the
  // next 30-second poll. Wake React at that exact boundary and on tab resume.
  useEffect(() => {
    if (loadedSnapshot?.transport !== "signed_snapshot") return;
    let expiryTimer: number | undefined;
    const checkExpiry = () => {
      const leftMs = Date.parse(loadedSnapshot.validUntil ?? "") - Date.now();
      if (Number.isFinite(leftMs) && leftMs > 0) {
        expiryTimer = window.setTimeout(checkExpiry, Math.max(1, Math.min(leftMs, 2_147_000_000)));
      } else {
        forceExpiryCheck((current) => current + 1);
      }
    };
    const onResume = () => forceExpiryCheck((current) => current + 1);
    checkExpiry();
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [loadedSnapshot]);

  const snapshot = displayableFleetSnapshot(loadedSnapshot);
  const errorForDisplay = loadedSnapshot && !snapshot ? "עותק Fleet חתום פג תוקף" : error;

  const collection = {
    state: snapshot ? "ready" as const : "unavailable" as const,
    freshness: snapshot ? "fresh" as const : "unknown" as const,
    items: snapshot?.machines ?? null,
    reason: snapshot ? null : errorForDisplay,
    provenance: {
      source: snapshot?.source ?? "Velvet Fleet Console",
      verifiedAt: snapshot?.fetchedAt,
      freshness: snapshot?.transport === "signed_snapshot"
        ? "fleet_signed_snapshot" : (snapshot ? "fleet_snapshot" : "unknown"),
    },
  };

  const signed = snapshot?.transport === "signed_snapshot";
  return <ModuleFrame collection={collection} definition={definition}>
    <div dir="rtl">
      <div className="row">
        <b>מחשבים הרשומים ב־Fleet: {snapshot ? snapshot.count : "—"}</b>
        <span>{snapshot
          ? (signed
            ? "עותק חתום: " + date(snapshot.fetchedAt) + " · תקף עד " + date(snapshot.validUntil ?? null)
            : "נשלף: " + date(snapshot.fetchedAt))
          : (loading ? "טוען..." : "מנותק")}</span>
      </div>
      <p>{signed
        ? "עותק מצב חתום וקצר־חיים מה־Fleet Console. הסטטוסים דווחו בזמן האיסוף ואינם חיבור חי או הרשאה לבצע פעולה במחשבים."
        : "רשימת מחשבים מה־Fleet Console הקיים. מצב וזמינות הם נתוני המקור; זו אינה טלמטריית CPU בזמן אמת."}</p>
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
