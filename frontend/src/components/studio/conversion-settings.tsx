import type { Health, OutputFormat, Quality, StudioSource, Voice } from "@/lib/studio-types";
import { Icon, Spinner } from "./icon";

interface Props {
  voice: Voice | undefined;
  source: StudioSource | null;
  quality: Quality;
  outputFormat: OutputFormat;
  health: Health | null;
  busy: boolean;
  canStart: boolean;
  unavailable: boolean;
  onQuality: (quality: Quality) => void;
  onFormat: (format: OutputFormat) => void;
  onStart: () => void;
}

export function ConversionSettings({ voice, source, quality, outputFormat, health, busy, canStart, unavailable, onQuality, onFormat, onStart }: Props) {
  return (
    <section className="panel settings-panel" aria-labelledby="settings-heading">
      <div className="section-heading"><div className="heading-with-step"><span className="step-number">02</span><h2 id="settings-heading">Make it yours</h2></div><Icon name="sliders" className="muted" /></div>
      <fieldset disabled={busy} className="setting-group">
        <legend>Processing mode</legend>
        <div className="quality-grid">
          {(["fast", "studio"] as const).map((value) => (
            <label key={value} className={`quality-option ${quality === value ? "is-selected" : ""}`}>
              <input type="radio" name="processing-quality" className="sr-only" value={value} checked={quality === value} onChange={() => onQuality(value)} />
              <span className="quality-title"><Icon name={value === "fast" ? "bolt" : "wave"} /><strong>{value === "fast" ? "Fast" : "Studio"}</strong><span className="radio-indicator">{quality === value && <span />}</span></span>
              <span>{value === "fast" ? "Compact reference pool" : "Full reference coverage"}</span>
            </label>
          ))}
        </div>
        <p className="field-help">{health?.quality_modes?.[quality]?.description || "Choose a smaller reference pool for less matching work, or full coverage for Studio."} Time depends on clip length, hardware and first-use preparation.</p>
      </fieldset>
      <fieldset disabled={busy} className="setting-group output-group">
        <legend>Export format</legend>
        <div className="output-options">
          {([
            ["original", source?.mediaKind === "audio" ? "Original · WAV" : "Original", "Original video / WAV audio"],
            ["wav", "WAV", "Uncompressed audio"],
            ["mp3", "MP3", "Compact audio"],
          ] as const).map(([value, name, description]) => (
            <label key={value} className={`output-option ${outputFormat === value ? "is-selected" : ""}`}>
              <input type="radio" name="output-format" className="sr-only" value={value} checked={outputFormat === value} onChange={() => onFormat(value)} />
              <strong>{name}</strong><span>{description}</span>
            </label>
          ))}
        </div>
        {outputFormat === "original" && source?.mediaKind === "video" && <p className="field-help">Keeps the original-quality video frames and replaces the audio track.</p>}
      </fieldset>
      <div className="selected-voice-summary">
        <span className="voice-avatar avatar-small" data-color={voice?.color ?? "indigo"}><Icon name="wave" /></span>
        <div><span className="eyebrow muted">Selected voice</span><p>{voice ? <><strong>{voice.name}</strong><span> · {voice.style}</span></> : "Choose a voice from the library"}</p></div>
        {voice && <span className="summary-accent">{voice.accent}</span>}
      </div>
      <button type="button" className="button button-primary convert-button" onClick={onStart} disabled={!canStart}>
        {busy ? <><Spinner /> Conversion in progress</> : <><Icon name="wave" /> Convert voice <Icon name="arrow" /></>}
      </button>
      <p className="cta-help">{busy ? "Live progress and controls are below. You can leave a job running in the background." : unavailable ? "Reconnect the engine to start a conversion." : !source ? "Add your media, choose a voice, and make it your own." : source.type === "saved" ? "Uses your saved upload. No need to upload again." : "A 5-second preview appears before the full export."}</p>
      <p className="preservation-note"><Icon name="check" /> Same words, language &amp; timing. Not translation.</p>
    </section>
  );
}