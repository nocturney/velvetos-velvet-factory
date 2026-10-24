import { useEffect, useState } from "react";
import { displayableFleetSnapshot, effectiveFleetNowMs, getFleetMachines, type FleetMachinesSnapshot } from "../fleet-api";
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

type ObservedSnapshot = {
  snapshot: FleetMachinesSnapshot;
  observedWallMs: number;
  observedMonotonicMs: number;
};

// A refresh that does not settle in time is treated as unavailable, never as the last green read.
const FLEET_REQUEST_DEADLINE_MS = 8_000;

export function FleetModule({ definition }: ModuleProps) {
  const [loadedSnapshot, setSnapshot] = useState<ObservedSnapshot | null>(null);
  const [error, setError] = useState("טוען נתונים מ־Fleet...");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let latest = 0;
    let inFlight: AbortController | undefined;
    const load = async () => {
      // Only the newest refresh may update rows; an older late result is ignored.
      const request = ++latest;
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      let timer: number | undefined;
      // A stalled GET may ignore its AbortSignal, so the deadline must fail closed on its own.
      const deadline = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => {
          controller.abort();
          reject(new Error("תם הזמן לקבלת נתוני Fleet"));
        }, FLEET_REQUEST_DEADLINE_MS);
      });
      try {
        const data = await Promise.race([getFleetMachines(controller.signal), deadline]);
        if (!active || request !== latest) return;
        setSnapshot({
          snapshot: data, observedWallMs: Date.now(), observedMonotonicMs: performance.now(),
        });
        setError("");
      } catch (reason) {
        if (!active || request !== latest) return;
        // Never retain a prior read as apparently current after a failed or timed-out refresh.
        setSnapshot(null);
        setError(reason instanceof Error ? reason.message : "מקור Fleet לא זמין");
      } finally {
        window.clearTimeout(timer);
        if (active && request === latest) setLoading(false);
      }
    };
    void load();
    const pollTimer = window.setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      inFlight?.abort();
      window.clearInterval(pollTimer);
    };
  }, []);

  // A short-lived signed copy expires on the original timeline even if the
  // browser clock is adjusted backwards after it was accepted. On expiry,
  // discard the copy irreversibly rather than allowing clock changes to revive it.
  useEffect(() => {
    if (loadedSnapshot?.snapshot.transport !== "signed_snapshot") return;
    let expiryTimer: number | undefined;
    let active = true;
    const checkExpiry = () => {
      if (!active) return;
      const effectiveNow = effectiveFleetNowMs(
        loadedSnapshot.observedWallMs, loadedSnapshot.observedMonotonicMs,
        Date.now(), performance.now(),
      );
      const leftMs = Date.parse(loadedSnapshot.snapshot.validUntil ?? "") - effectiveNow;
      if (Number.isFinite(leftMs) && leftMs > 0) {
        expiryTimer = window.setTimeout(checkExpiry, Math.max(1, Math.min(leftMs, 2_147_000_000)));
      } else {
        setSnapshot((current) => current === loadedSnapshot ? null : current);
        setError("עותק Fleet חתום פג תוקף");
      }
    };
    const onResume = () => {
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      checkExpiry();
    };
    checkExpiry();
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      active = false;
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [loadedSnapshot]);

  const snapshotNow = loadedSnapshot
    ? effectiveFleetNowMs(
      loadedSnapshot.observedWallMs, loadedSnapshot.observedMonotonicMs,
      Date.now(), performance.now(),
    )
    : Date.now();
  const snapshot = displayableFleetSnapshot(loadedSnapshot?.snapshot ?? null, snapshotNow);
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
