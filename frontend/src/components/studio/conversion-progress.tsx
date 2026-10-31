import { STATUS_LABELS, isTerminal, type Job, type UploadState, type Voice } from "@/lib/studio-types";
import { clampPercent, formatTime } from "@/lib/studio-utils";
import { Icon, Spinner } from "./icon";

interface Props {
  job: Job | null;
  jobId: string | null;
  upload: UploadState | null;
  voices: Voice[];
  pollError: string | null;
  pollPaused: boolean;
  cancelling: boolean;
  onResume: () => void;
  onAbortUpload: () => void;
  onCancel: () => void;
  onBackground: () => void;
}

export function ConversionProgress({ job, jobId, upload, voices, pollError, pollPaused, cancelling, onResume, onAbortUpload, onCancel, onBackground }: Props) {
  if (!jobId && !upload) return null;
  const percent = upload ? upload.percent : job ? clampPercent(job.progress) : null;
  const terminal = !!job && isTerminal(job);
  const title = upload ? upload.reused ? "Reusing your saved upload" : upload.waiting ? "Upload complete · awaiting job ID" : "Uploading your media"
    : job ? STATUS_LABELS[job.status] : "Connecting to your conversion";
  const detail = upload ? upload.waiting ? "Waiting for the server to accept the conversion request…" : "Sending your file to the conversion engine…"
    : job?.detail ?? "Fetching the latest saved status…";
  const voice = voices.find((item) => item.id === job?.voice);
  const processingRate = job?.realtime_factor;

  return (
    <section className={`panel conversion-progress ${job?.status === "done" ? "is-complete" : ""}`} aria-labelledby="conversion-progress-heading">
      <div className="progress-topline">
        <div className="progress-identity"><span className={`progress-icon ${terminal ? "is-terminal" : ""}`}>{job?.status === "done" ? <Icon name="check" /> : terminal ? <Icon name={job.status === "error" ? "info" : "stop"} /> : <Spinner />}</span><div><span className="eyebrow muted">{upload ? "Step 1 · Transfer" : "Your conversion"}</span><h2 id="conversion-progress-heading">{title}</h2></div></div>
        <span className="progress-percent">{percent === null ? "—" : `${percent}%`}</span>
      </div>
      {job && <p className="progress-filename" title={job.filename}>{job.filename} <span>· {voice?.name ?? job.voice} · {job.quality === "fast" ? "Fast" : "Studio"}</span></p>}
      <p className="progress-detail" role="status" aria-live="polite">{detail}</p>
      <div className={`progress-track ${percent === null ? "is-indeterminate" : ""}`} role="progressbar" aria-label={upload ? "File upload progress" : "Conversion progress"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? title : `${percent}% · ${title}`}><span style={{ width: percent === null ? "35%" : `${percent}%` }} /></div>
      {job && (
        <>
          <div className="processing-stats">
            <div><span>Active elapsed</span><strong>{formatTime(job.elapsed_seconds)}</strong></div>
            <div><span>{job.status === "queued" ? "Queue position" : "Estimated remaining"}</span><strong>{job.status === "queued" ? job.queue_position > 0 ? `#${job.queue_position}` : "Checking…" : job.eta_seconds != null ? `~${formatTime(job.eta_seconds)}` : terminal ? "—" : "Estimating…"}</strong></div>
            {job.processed_seconds != null && <div><span>Media processed</span><strong>{formatTime(job.processed_seconds)}{job.duration != null ? ` / ${formatTime(job.duration)}` : ""}</strong></div>}
            {processingRate != null && Number.isFinite(processingRate) && processingRate > 0 && <div><span>Pipeline rate</span><strong>{processingRate.toFixed(2)}× realtime</strong></div>}
          </div>
          <div className="cache-badges">
            {job.source_reused && <span><Icon name="reuse" /> Saved upload reused</span>}
            {job.conversion_cache_hit && <span><Icon name="bolt" /> Converted audio reused · inference skipped</span>}
            {job.source_cache_hit && <span><Icon name="bolt" /> Source cache reused</span>}
            {!!job.feature_cache_hits && <span><Icon name="bolt" /> Feature cache hits: {job.feature_cache_hits}</span>}
          </div>
          {processingRate != null && processingRate > 0 && <p className="field-help">Pipeline rate measures audio seconds per compute second for feature extraction, matching and synthesis. It excludes upload, startup and packaging—not an end-to-end speed estimate.</p>}
          {job.status === "error" && <div className="notice notice-error" role="alert"><p>{job.error || "The conversion failed. Reuse the upload to try again."}</p></div>}
          {job.status === "cancelled" && <p className="field-help">Your upload is kept. Reuse it from Recent conversions without uploading again.</p>}
          {job.status === "cancelling" && <p className="field-help">Cancellation takes effect when the current processing step finishes. Your upload will remain available.</p>}
          {!job.preview && !terminal && job.status !== "cancelling" && <p className="field-help">The 5-second preview appears first. First-use model or reference preparation can take longer.</p>}
        </>
      )}
      {pollError && <div className="notice notice-warning" role="alert"><p>{pollError}</p><button type="button" className="button button-secondary" onClick={onResume}>{pollPaused ? "Resume updates" : "Retry now"}</button></div>}
      <div className="progress-actions">
        {upload ? <><p className="field-help">Aborting this request does not confirm server-side cancellation.</p><button type="button" className="button button-danger" onClick={onAbortUpload}>Abort upload request</button></> : !terminal ? <><button type="button" className="text-button" onClick={onBackground}>Keep running in background</button><button type="button" className="button button-danger" disabled={cancelling || job?.status === "cancelling"} onClick={onCancel}>{cancelling ? "Requesting cancellation…" : job?.status === "cancelling" ? "Stopping after current step…" : "Cancel conversion"}</button></> : null}
      </div>
    </section>
  );
}