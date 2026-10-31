import { jobUrl } from "@/lib/studio-api";
import { isTerminal, STATUS_LABELS, type Job, type Voice } from "@/lib/studio-types";
import { formatSize } from "@/lib/studio-utils";
import { Icon, Spinner } from "./icon";

interface Props {
  jobs: Job[];
  voices: Voice[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  locked: boolean;
  deletingId: string | null;
  onRefresh: () => void;
  onView: (job: Job) => void;
  onReuse: (job: Job) => void;
  onDelete: (job: Job) => void;
}

export function RecentConversions({ jobs, voices, selectedId, loading, error, locked, deletingId, onRefresh, onView, onReuse, onDelete }: Props) {
  const active = jobs.filter((job) => !isTerminal(job)).length;
  return (
    <section className="panel history-panel" aria-labelledby="recent-heading" id="recent-conversions">
      <div className="section-heading"><div><span className="eyebrow muted">Your local workspace</span><h2 id="recent-heading">Recent conversions</h2></div><div className="history-heading-actions"><span className="subtle-badge">{active}/8 active</span><button type="button" className="button button-secondary button-small" onClick={onRefresh} disabled={loading}><Icon name="refresh" className={loading ? "spin" : ""} />Refresh</button></div></div>
      <p className="section-description">Saved on the backend, even after a reload. Reuse an upload to explore another voice.</p>
      {error && <div className="notice notice-error" role="alert"><p>{error}</p><button type="button" className="text-button" onClick={onRefresh}>Retry history</button></div>}
      {loading && !jobs.length ? <div className="empty-state" role="status"><Spinner /><p>Loading saved conversions…</p></div> : !jobs.length ? <div className="empty-state"><span className="empty-icon"><Icon name="clock" /></span><h3>{error ? "History is unavailable" : "Your next creation starts here"}</h3><p>{error ? "Reconnect and refresh to recover your saved uploads and jobs." : "Your conversions will appear here. Sources can be reused without uploading again."}</p></div> : (
        <ul className="history-list">
          {jobs.map((job) => {
            const voice = voices.find((item) => item.id === job.voice);
            return (
              <li key={job.id} className={`history-row ${selectedId === job.id ? "is-selected" : ""}`}>
                <button type="button" className="history-select" disabled={locked || deletingId === job.id} onClick={() => onView(job)} aria-pressed={selectedId === job.id} aria-label={`View ${job.filename}, ${voice?.name ?? job.voice}, ${STATUS_LABELS[job.status]}`}>
                  <span className="history-file-icon"><Icon name={job.source_kind === "video" ? "video" : "audio"} /></span>
                  <span className="history-file-info"><strong title={job.filename}>{job.filename}</strong><span>{formatSize(job.size_bytes)} · <time dateTime={new Date(job.created_at * 1000).toISOString()}>{new Date(job.created_at * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></span></span>
                  <span className="history-voice"><strong>{voice?.name ?? job.voice}</strong><span>{job.quality === "fast" ? "Fast" : "Studio"} · {job.output_ext.replace(".", "").toUpperCase()}</span></span>
                  <span className={`job-status status-${job.status}`}><span className="status-dot" />{STATUS_LABELS[job.status]}</span>
                </button>
                <div className="history-actions">
                  <button type="button" className="icon-button" disabled={locked || deletingId === job.id} onClick={() => onReuse(job)} aria-label={`Reuse upload ${job.filename}`} title="Reuse upload"><Icon name="reuse" /></button>
                  {job.status === "done" && <a className="icon-button" href={jobUrl(job.id, "download")} download aria-label={`Download ${job.filename} with ${voice?.name ?? job.voice}`} title="Download full export"><Icon name="download" /></a>}
                  {isTerminal(job) && <button type="button" className="icon-button delete-button" disabled={locked || deletingId !== null} onClick={() => onDelete(job)} aria-label={`Delete ${job.filename} conversion`} title="Delete conversion and its saved upload">{deletingId === job.id ? <Spinner /> : <Icon name="trash" />}</button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!!jobs.length && <p className="history-footnote">Showing up to 30 recent conversions. Active jobs must be cancelled before they can be removed.</p>}
    </section>
  );
}