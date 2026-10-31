import { jobUrl } from "@/lib/studio-api";
import type { Job, Voice } from "@/lib/studio-types";
import { isTerminal } from "@/lib/studio-types";
import { Icon, Spinner } from "./icon";
import { MediaPreview } from "./media-preview";

interface Props {
  job: Job;
  voice: Voice | undefined;
  onReuse: () => void;
  onPlay: () => void;
}

export function ConversionResult({ job, voice, onReuse, onPlay }: Props) {
  if (!job.preview && job.status !== "done") return null;
  return (
    <section className="panel result-panel" aria-labelledby="result-heading">
      <div className="section-heading"><div className="heading-with-step"><span className="step-number">03</span><h2 id="result-heading">Hear the difference</h2></div><span className="subtle-badge">5-second comparison</span></div>
      <p className="section-description">Your original speech, then {voice?.name ?? job.voice}. Playback starts only when you press play.</p>
      <div className="comparison-grid">
        <div><div className="comparison-label"><span className="comparison-dot" /> Original <span>First 5 seconds</span></div><MediaPreview key={`${job.id}-original-${job.source_kind}`} src={jobUrl(job.id, "source")} kind={job.source_kind} label="Original speech, first five seconds" limitSeconds={5} onPlay={onPlay} /></div>
        <div><div className="comparison-label"><span className="comparison-dot is-converted" /> {voice?.name ?? "Converted"} <span>Converted preview</span></div>{job.preview ? <MediaPreview key={`${job.id}-converted`} src={jobUrl(job.id, "preview")} kind={job.output_kind} label="Converted speech, five-second preview" limitSeconds={5} onPlay={onPlay} /> : <div className="media-fallback"><p>No preview was saved. The full export is available below.</p></div>}</div>
      </div>
      {job.output_kind === "video" && <p className="field-help">The converted preview uses browser-friendly MP4. The full export keeps the original video container, which your browser may not support.</p>}
      <div className="result-actions">
        {job.status === "done" ? <><a className="button button-success" href={jobUrl(job.id, "download")} download><Icon name="download" /> Download full {job.output_kind === "video" ? "video" : "audio"}<span className="download-format">{job.output_ext.replace(".", "").toUpperCase()}</span></a><a className="button button-secondary" href={jobUrl(job.id, "audio")} download><Icon name="audio" /> Download WAV audio</a></> : <p className="download-pending">{isTerminal(job) ? <Icon name="info" /> : <Spinner />}{isTerminal(job) ? "This preview is available, but the full export did not finish." : "Full export unlocks when conversion is complete."}</p>}
        <button type="button" className="button button-secondary" onClick={onReuse}><Icon name="reuse" /> Try another voice</button>
      </div>
      <p className="field-help">Trying another voice reuses this saved source. {isTerminal(job) ? "No re-upload needed." : "The current conversion will keep running unless you cancel it."}</p>
    </section>
  );
}