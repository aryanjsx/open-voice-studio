export type Quality = "fast" | "studio";
export type OutputFormat = "original" | "wav" | "mp3";
export type MediaKind = "video" | "audio";

export interface Voice {
  id: string;
  name: string;
  label: string;
  style: string;
  description: string;
  accent: string;
  gender: "male" | "female";
  color: "amber" | "rose" | "indigo" | "cyan" | "violet" | "pink" | "emerald" | "sky";
  languages: string[];
  sample_url: string;
  sample_seconds: number;
  sample_ready: boolean;
  reference_ready: boolean;
}

export interface Health {
  status: "ok";
  engine: {
    device: "cpu" | "cuda";
    threads: number;
    ready: boolean;
    error: string | null;
    name: string;
  };
  preview_seconds: number;
  max_upload_bytes: number;
  max_duration_seconds: number;
  formats: string[];
  quality_modes: Record<Quality, { label: string; description: string; max_frames: number | null }>;
}

export const JOB_STATUSES = [
  "queued", "processing_preview", "processing_full", "finalizing",
  "cancelling", "cancelled", "done", "error",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface Job {
  id: string;
  status: JobStatus;
  voice: string;
  quality: Quality;
  output_format: OutputFormat;
  output_kind: MediaKind;
  output_ext: string;
  source_kind: MediaKind;
  filename: string;
  name: string;
  size_bytes: number;
  source_reused: boolean;
  created_at: number;
  progress: number;
  preview: boolean;
  detail: string;
  error: string | null;
  elapsed_seconds: number;
  queue_position: number;
  started_at?: number;
  finished_at?: number;
  duration?: number;
  processed_seconds?: number;
  source_cache_hit?: boolean;
  conversion_cache_hit?: boolean;
  feature_cache_hits?: number;
  silent_seconds?: number;
  eta_seconds?: number | null;
  realtime_factor?: number | null;
}

interface SourceMetadata {
  filename: string;
  size: number;
  mediaKind: MediaKind;
  url: string;
}

export type StudioSource = SourceMetadata & (
  | { type: "file"; file: File }
  | { type: "saved"; jobId: string }
);

export interface ConversionInput {
  source: StudioSource;
  voice: string;
  quality: Quality;
  outputFormat: OutputFormat;
}

export interface UploadState {
  percent: number | null;
  waiting: boolean;
  reused: boolean;
}

export function isTerminal(job: Pick<Job, "status">) {
  return job.status === "done" || job.status === "error" || job.status === "cancelled";
}

const STATUS_ORDER: Record<JobStatus, number> = {
  queued: 0, processing_preview: 1, processing_full: 2, finalizing: 3,
  cancelling: 4, cancelled: 5, done: 5, error: 5,
};

// A response already in flight must not undo a cancellation or a terminal state.
export function newerJob(previous: Job | null | undefined, incoming: Job): Job {
  if (!previous || previous.id !== incoming.id) return incoming;
  if (STATUS_ORDER[incoming.status] < STATUS_ORDER[previous.status]) return previous;
  if (!isTerminal(incoming) && incoming.status !== "cancelling" && incoming.progress < previous.progress) {
    return previous;
  }
  return incoming;
}

export const STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  processing_preview: "Creating preview",
  processing_full: "Converting full media",
  finalizing: "Packaging export",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  done: "Ready",
  error: "Failed",
};