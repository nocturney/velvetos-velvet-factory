import { useEffect, useState } from "react";
import { controlApi } from "./control-api";
import { isControlSnapshot } from "./snapshot-health";
import type { ControlSnapshot } from "./types";

const POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;

export function useControlSnapshot() {
  const [snapshot, setSnapshot] = useState<ControlSnapshot | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    let generation = 0;
    let ongoing: AbortController | null = null;

    const refresh = async () => {
      const request = ++generation;
      ongoing?.abort();
      const controller = new AbortController();
      ongoing = controller;
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const next = await controlApi.snapshot(controller.signal);
        if (!active || request !== generation) return;
        if (!isControlSnapshot(next)) throw new Error("invalid_control_schema");
        setSnapshot(next);
        setError("");
      } catch {
        if (!active || request !== generation) return;
        // A failed refresh must never leave the previous result looking current.
        setSnapshot(null);
        setError("Control API לא זמין או דורש אימות.");
      } finally {
        window.clearTimeout(timeout);
      }
    };

    void refresh();
    const polling = window.setInterval(() => void refresh(), POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      active = false;
      ongoing?.abort();
      window.clearInterval(polling);
      window.clearInterval(clock);
    };
  }, []);

  return { snapshot, error, now };
}
