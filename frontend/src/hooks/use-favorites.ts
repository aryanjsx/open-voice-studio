import { useMemo, useSyncExternalStore } from "react";
import { readStorage, writeStorage } from "@/lib/studio-utils";

const KEY = "voice-studio.favorites.v1";
const EVENT = "voice-studio-favorites";
let memoryFallback = "[]";
let useMemoryFallback = false;

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(EVENT, callback);
  };
}

function snapshot() { return useMemoryFallback ? memoryFallback : readStorage(KEY) ?? memoryFallback; }
function serverSnapshot() { return "[]"; }

export function useFavorites() {
  const stored = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const favorites = useMemo<string[]>(() => {
    try {
      const value: unknown = JSON.parse(stored);
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, 100) : [];
    } catch { return []; }
  }, [stored]);

  function toggle(id: string) {
    memoryFallback = JSON.stringify(favorites.includes(id) ? favorites.filter((item) => item !== id) : [...favorites, id]);
    useMemoryFallback = !writeStorage(KEY, memoryFallback);
    window.dispatchEvent(new Event(EVENT));
  }

  return { favorites, toggle };
}