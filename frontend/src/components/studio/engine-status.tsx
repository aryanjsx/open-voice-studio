import type { Health } from "@/lib/studio-types";
import { Icon, Spinner } from "./icon";

export function EngineStatus({ health, error, loading, onReload }: { health: Health | null; error: string | null; loading: boolean; onReload: () => void }) {
  const unavailable = !!error || !!health?.engine.error;
  const state = unavailable ? "offline" : health?.engine.ready ? "ready" : "warming";
  const label = unavailable ? "Engine unavailable" : health ? `${health.engine.device.toUpperCase()} · ${health.engine.ready ? "Ready" : "Warming up"}` : "Connecting to engine";
  return (
    <button type="button" className={`engine-badge engine-${state}`} onClick={onReload} disabled={loading} aria-label={`${label}. Refresh engine status.`} title={health && !error ? `${health.engine.name} · ${health.engine.threads} threads. Click to refresh.` : "Click to retry the backend connection"}>
      {loading && !health ? <Spinner /> : <Icon name="cpu" />}<span aria-live="polite">{label}</span><span className="status-dot" />
    </button>
  );
}