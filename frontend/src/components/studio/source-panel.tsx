import { useRef, useState, type DragEvent } from "react";
import type { StudioSource } from "@/lib/studio-types";
import { ACCEPTED_EXTENSIONS, formatSize } from "@/lib/studio-utils";
import { Icon } from "./icon";
import { MediaPreview } from "./media-preview";

interface Props {
  source: StudioSource | null;
  error: string | null;
  disabled: boolean;
  maxDurationSeconds: number;
  onFile: (file: File) => void;
  onError: (message: string) => void;
  onClear: () => void;
  onPlay: () => void;
}

export function SourcePanel({ source, error, disabled, maxDurationSeconds, onFile, onError, onClear, onPlay }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    if (event.dataTransfer.files.length !== 1) { onError("Drop one video or audio file at a time."); return; }
    onFile(event.dataTransfer.files[0]);
  }

  return (
    <section className="panel source-panel" aria-labelledby="source-heading">
      <div className="section-heading">
        <div className="heading-with-step"><span className="step-number">01</span><h2 id="source-heading">Your source</h2></div>
        <span className="eyebrow muted">Video or audio</span>
      </div>
      <input ref={input} type="file" accept={ACCEPTED_EXTENSIONS.join(",")} className="sr-only" tabIndex={-1} aria-label="Choose a video or audio file" disabled={disabled} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        if (file) onFile(file);
        event.currentTarget.value = "";
      }} />
      <div
        className={`drop-zone ${dragging && !disabled ? "is-dragging" : ""} ${source ? "has-source" : ""}`}
        onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={drop}
      >
        {source ? (
          <div className="source-file">
            <span className="file-icon"><Icon name={source.mediaKind === "video" ? "video" : "audio"} /></span>
            <div className="file-info">
              <p className="truncate" title={source.filename}>{source.filename}</p>
              <span>{formatSize(source.size)} · {source.mediaKind === "video" ? "Video" : "Audio"}</span>
              {source.type === "saved" && <span className="saved-label"><Icon name="reuse" /> Saved upload · no re-upload</span>}
            </div>
            <button type="button" className="icon-button" onClick={onClear} disabled={disabled} aria-label="Clear selected source" title="Clear source"><Icon name="close" /></button>
          </div>
        ) : (
          <button type="button" className="drop-trigger" onClick={() => input.current?.click()} disabled={disabled} aria-describedby="source-formats source-tip">
            <span className="upload-symbol"><Icon name="upload" /></span>
            <span className="drop-title">Drop your media here</span>
            <span className="drop-description">or <span>browse files</span> to get started</span>
            <span className="upload-limits">Up to 512 MB · {Math.round(maxDurationSeconds / 60)} min maximum</span>
          </button>
        )}
      </div>
      {source && (
        <div className="source-preview">
          <div className="inline-heading"><span>Original media</span><button type="button" className="text-button" disabled={disabled} onClick={() => input.current?.click()}>Replace file</button></div>
          <MediaPreview key={source.url} src={source.url} kind={source.mediaKind} label={`Original: ${source.filename}`} onPlay={onPlay} compact />
        </div>
      )}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <p className="format-help" id="source-formats">MP4, MOV, M4V, MKV, WebM · MP3, WAV, M4A, FLAC, OGG, AAC, Opus</p>
      <div className="help-note" id="source-tip"><Icon name="info" /><p>Speech-only media works best. Background music is not separately preserved. The server checks the {Math.round(maxDurationSeconds / 60)}-minute limit.</p></div>
    </section>
  );
}