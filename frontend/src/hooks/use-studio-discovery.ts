import { useCallback, useEffect, useState } from "react";
import { errorMessage, requestJson } from "@/lib/studio-api";
import type { Health, Voice } from "@/lib/studio-types";

export function useStudioDiscovery() {
  const [health, setHealth] = useState<Health | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  const reload = useCallback(() => {
    setLoading(true);
    setVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    async function discover() {
      const [engine, catalog] = await Promise.allSettled([
        requestJson<Health>("/api/health", { signal: controller.signal }),
        requestJson<Voice[]>("/api/voices", { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      const validEngine = engine.status === "fulfilled" && engine.value?.status === "ok" && !!engine.value.engine;
      const validVoices = catalog.status === "fulfilled" && Array.isArray(catalog.value);
      if (validEngine) {
        setHealth(engine.value);
        setHealthError(null);
      } else {
        setHealthError(engine.status === "rejected" ? errorMessage(engine.reason) : "The engine returned an unexpected response.");
      }
      if (validVoices) {
        setVoices(catalog.value);
        setVoicesError(null);
      } else {
        setVoicesError(catalog.status === "rejected" ? errorMessage(catalog.reason) : "The voice catalog could not be read.");
      }
      setLoading(false);
      failures = validEngine && validVoices ? 0 : failures + 1;
      // No unbounded retries against an unavailable backend. Manual retry starts a new cycle.
      if (failures < 4) {
        const delay = failures ? 3000 * 2 ** (failures - 1) : validEngine && !engine.value.engine.ready ? 10000 : 45000;
        timer = setTimeout(() => void discover(), delay);
      }
    }

    void discover();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [version]);

  return { health, voices, healthError, voicesError, loading, reload };
}