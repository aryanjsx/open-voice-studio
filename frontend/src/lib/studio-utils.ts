import { jobUrl } from "./studio-api";
import type { Job, StudioSource } from "./studio-types";

export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".mkv", ".webm"];
export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".opus"];
export const ACCEPTED_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];
export const MAX_UPLOAD_BYTES = 512 * 1024 ** 2;

export function extensionOf(name: string) {
  return name.slice(name.lastIndexOf(".")).toLowerCase();
}

export function validateFile(file: File, maxBytes = MAX_UPLOAD_BYTES): string | null {
  if (!ACCEPTED_EXTENSIONS.includes(extensionOf(file.name))) {
    return "Unsupported file. Choose MP4, MOV, M4V, MKV, WebM, MP3, WAV, M4A, FLAC, OGG, AAC or Opus.";
  }
  if (file.size === 0) return "This file is empty. Choose a file containing audio.";
  if (file.size > Math.min(maxBytes, MAX_UPLOAD_BYTES)) return "This file is too large. Choose media no larger than 512 MB.";
  return null;
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "—";
  const value = Math.max(0, Math.round(seconds));
  if (value >= 3600) return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
  if (value >= 60) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${value}s`;
}

export function clampPercent(value: number) {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0;
}

export function savedSource(job: Job): StudioSource {
  return {
    type: "saved", jobId: job.id, filename: job.filename, size: job.size_bytes,
    mediaKind: job.source_kind, url: jobUrl(job.id, "source"),
  };
}

export function readStorage(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

export function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    // Storage can be disabled or full. The studio still works without persistence.
    return false;
  }
}

export function pauseMedia(except?: HTMLMediaElement) {
  document.querySelectorAll<HTMLMediaElement>("audio, video").forEach((media) => {
    if (media !== except) media.pause();
  });
}