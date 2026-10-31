import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, requestSample } from "@/lib/studio-api";
import type { Voice } from "@/lib/studio-types";
import { pauseMedia } from "@/lib/studio-utils";

export interface SampleState {
  voiceId: string | null;
  phase: "idle" | "loading" | "playing" | "error";
  progress: number;
  error: string | null;
}

const IDLE: SampleState = { voiceId: null, phase: "idle", progress: 0, error: null };

function releaseAudio(audio: HTMLAudioElement | null) {
  if (!audio) return;
  audio.onended = null;
  audio.ontimeupdate = null;
  audio.onerror = null;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
}

export function useVoiceSamples() {
  const [state, setState] = useState<SampleState>(IDLE);
  const audio = useRef<HTMLAudioElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const urls = useRef(new Map<string, string>());
  const generation = useRef(0);
  const currentVoice = useRef<string | null>(null);

  const stop = useCallback(() => {
    generation.current += 1;
    currentVoice.current = null;
    request.current?.abort();
    request.current = null;
    releaseAudio(audio.current);
    audio.current = null;
    setState(IDLE);
  }, []);

  useEffect(() => {
    const cache = urls.current;
    return () => {
      generation.current += 1;
      currentVoice.current = null;
      request.current?.abort();
      releaseAudio(audio.current);
      audio.current = null;
      cache.forEach((url) => URL.revokeObjectURL(url));
      cache.clear();
    };
  }, []);

  async function toggle(voice: Voice) {
    if (currentVoice.current === voice.id) { stop(); return; }
    stop();
    pauseMedia();
    const token = generation.current;
    currentVoice.current = voice.id;
    const controller = new AbortController();
    request.current = controller;
    setState({ voiceId: voice.id, phase: "loading", progress: 0, error: null });
    let failed = false;
    const isCurrent = () => generation.current === token && !controller.signal.aborted && !failed;
    const fail = (message: string, discardSample = false) => {
      if (!isCurrent()) return;
      failed = true;
      releaseAudio(audio.current);
      audio.current = null;
      currentVoice.current = null;
      if (discardSample) {
        const cached = urls.current.get(voice.sample_url);
        if (cached) URL.revokeObjectURL(cached);
        urls.current.delete(voice.sample_url);
      }
      setState({ voiceId: voice.id, phase: "error", progress: 0, error: message });
    };

    try {
      let url = urls.current.get(voice.sample_url);
      if (!url) {
        const blob = await requestSample(voice.sample_url, controller.signal);
        if (!isCurrent()) return;
        url = URL.createObjectURL(blob);
        urls.current.set(voice.sample_url, url);
      }
      if (!isCurrent()) return;
      const player = new Audio(url);
      audio.current = player;
      player.onended = () => { if (isCurrent()) stop(); };
      player.ontimeupdate = () => {
        if (!isCurrent()) return;
        if (player.currentTime >= voice.sample_seconds) { stop(); return; }
        setState((previous) => ({ ...previous, progress: Math.min(100, player.currentTime / voice.sample_seconds * 100) }));
      };
      player.onerror = () => fail("This browser could not play the sample. Press Play to retry.", true);
      await player.play();
      if (isCurrent()) setState({ voiceId: voice.id, phase: "playing", progress: 0, error: null });
    } catch (error) {
      if (!isCurrent()) return;
      fail(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Your browser blocked playback. Press Play again to hear the cached sample."
        : errorMessage(error));
    }
  }

  return { state, toggle, stop };
}