"use client";

import { useRef, useState } from "react";
import { useStudioDiscovery } from "@/hooks/use-studio-discovery";
import { useStudioJobs } from "@/hooks/use-studio-jobs";
import { useStudioSource } from "@/hooks/use-studio-source";
import { useVoiceSamples } from "@/hooks/use-voice-samples";
import { isTerminal, type Job, type OutputFormat, type Quality } from "@/lib/studio-types";
import { MAX_UPLOAD_BYTES, pauseMedia, savedSource } from "@/lib/studio-utils";
import { ConversionProgress } from "./conversion-progress";
import { ConversionResult } from "./conversion-result";
import { ConversionSettings } from "./conversion-settings";
import { EngineStatus } from "./engine-status";
import { Icon, Waveform } from "./icon";
import { RecentConversions } from "./recent-conversions";
import { SourcePanel } from "./source-panel";
import { VoiceLibrary } from "./voice-library";

function focusRegion(element: HTMLElement | null) {
  if (!element) return;
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

export function VoiceStudio() {
  const discovery = useStudioDiscovery();
  const jobs = useStudioJobs();
  const sources = useStudioSource(discovery.health?.max_upload_bytes ?? MAX_UPLOAD_BYTES);
  const samples = useVoiceSamples();
  const [voiceDraft, setVoice] = useState<string | null>(null);
  const [qualityDraft, setQuality] = useState<Quality | null>(null);
  const [formatDraft, setOutputFormat] = useState<OutputFormat | null>(null);
  const activityRef = useRef<HTMLDivElement>(null);
  const libraryRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const job = jobs.job;
  const voiceId = voiceDraft ?? job?.voice ?? "male";
  const quality = qualityDraft ?? job?.quality ?? "studio";
  const outputFormat = formatDraft ?? job?.output_format ?? "original";
  const source = sources.source ?? (job ? savedSource(job) : null);
  const selectedVoice = discovery.voices.find((voice) => voice.id === voiceId);
  const busy = !!jobs.upload || (!!jobs.selectedId && (!job || !isTerminal(job)));
  // A conversion retries a failed warmup; keep that recovery path available.
  const unavailable = !!discovery.healthError || !discovery.health;
  const canStart = !!source && !!selectedVoice && !busy && !unavailable && !jobs.deletingId;

  function stopPlayback() { samples.stop(); pauseMedia(); }

  function newConversion() {
    if (jobs.upload) return;
    stopPlayback();
    jobs.clearSelection();
    sources.clear();
    setVoice(null);
    setQuality(null);
    setOutputFormat(null);
    requestAnimationFrame(() => focusRegion(workspaceRef.current));
  }

  function chooseFile(file: File) {
    stopPlayback();
    if (sources.chooseFile(file)) jobs.clearSelection();
  }

  function start() {
    if (!source || !canStart) return;
    stopPlayback();
    setVoice(voiceId);
    setQuality(quality);
    setOutputFormat(outputFormat);
    if (source.type === "saved") sources.markSaved(source.jobId, source);
    // Capture the source before the async upload; a saved source never includes a file field.
    jobs.start({ source, voice: voiceId, quality, outputFormat }, (id) => sources.markSaved(id, source));
    requestAnimationFrame(() => focusRegion(activityRef.current));
  }

  function viewJob(next: Job) {
    stopPlayback();
    sources.reuse(next);
    setVoice(next.voice);
    setQuality(next.quality);
    setOutputFormat(next.output_format);
    jobs.selectJob(next);
    requestAnimationFrame(() => focusRegion(activityRef.current));
  }

  function reuseJob(next: Job) {
    if (jobs.upload) return;
    stopPlayback();
    jobs.clearSelection();
    sources.reuse(next);
    setVoice(next.voice);
    setQuality(next.quality);
    setOutputFormat(next.output_format);
    requestAnimationFrame(() => focusRegion(libraryRef.current));
  }

  return (
    <div className="studio-shell">
      <a href="#studio-workspace" className="skip-link">Skip to the studio</a>
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><Icon name="wave" /></span><span>Voice<span className="brand-light">Studio</span></span><span className="workspace-badge">Local workspace</span></div>
        <div className="topbar-actions"><a className="history-link" href="#recent-conversions"><Icon name="clock" /><span>Recent</span></a><EngineStatus health={discovery.health} error={discovery.healthError} loading={discovery.loading} onReload={discovery.reload} /></div>
      </header>
      <main className="studio-main">
        <section className="studio-hero" aria-labelledby="studio-title">
          <div><p className="eyebrow hero-eyebrow"><span /> A new voice. Still your story.</p><h1 id="studio-title">Your words.<br /><span>A different voice.</span></h1><p className="hero-description">Transform the voice in your video or audio.<br className="desktop-break" /> Keep the words, the language, and the moment.</p><div className="hero-features"><span><Icon name="headphones" /> 5-second previews</span><span><Icon name="reuse" /> Reusable uploads</span><span><Icon name="video" /> Video + audio</span></div></div>
          <div className="hero-art" aria-hidden="true"><div className="hero-art-label"><span>ORIGINAL</span><span>REIMAGINED</span></div><Waveform className="hero-wave" /><div className="hero-art-rule" /><span className="hero-art-caption">Same story. A new sound.</span></div>
        </section>

        {(discovery.healthError || discovery.health?.engine.error) && <div className="notice notice-error connection-notice" role="alert"><Icon name="info" /><div><strong>{discovery.healthError ? "Backend connection unavailable" : "Engine needs attention"}</strong><p>{discovery.healthError ?? discovery.health?.engine.error}</p></div><button type="button" className="button button-secondary" onClick={() => { discovery.reload(); jobs.refreshHistory(); }} disabled={discovery.loading}>Retry connection</button></div>}
        {jobs.notice && <div className="notice notice-info" role="status"><Icon name="info" /><p>{jobs.notice}</p><button type="button" className="icon-button" aria-label="Dismiss notice" onClick={jobs.dismissNotice}><Icon name="close" /></button></div>}
        {jobs.actionError && <div className="notice notice-error" role="alert"><Icon name="info" /><p>{jobs.actionError}</p><button type="button" className="icon-button" aria-label="Dismiss error" onClick={jobs.dismissError}><Icon name="close" /></button></div>}

        <div className="workspace-title"><div><span className="workspace-indicator" /><h2>Your studio</h2></div><button type="button" className="text-button" onClick={newConversion} disabled={!!jobs.upload || !!jobs.deletingId}><Icon name="refresh" /> New conversion</button></div>
        <div className="studio-grid" id="studio-workspace" ref={workspaceRef} tabIndex={-1}>
          <div className="studio-inputs">
            <SourcePanel source={source} error={sources.error} disabled={busy || !!jobs.deletingId} maxDurationSeconds={discovery.health?.max_duration_seconds ?? 3600} onFile={chooseFile} onError={sources.setError} onClear={() => { stopPlayback(); sources.clear(); jobs.clearSelection(); }} onPlay={samples.stop} />
            <ConversionSettings voice={selectedVoice} source={source} quality={quality} outputFormat={outputFormat} health={discovery.health} busy={busy} canStart={canStart} unavailable={unavailable} onQuality={setQuality} onFormat={setOutputFormat} onStart={start} />
          </div>
          <div className="studio-library" ref={libraryRef} tabIndex={-1}><VoiceLibrary voices={discovery.voices} selected={voiceId} loading={discovery.loading} error={discovery.voicesError} disabled={busy} sample={samples.state} onSelect={setVoice} onSample={(voice) => void samples.toggle(voice)} onStopSample={samples.stop} onReload={discovery.reload} /></div>
        </div>

        <div className="studio-activity" id="conversion-activity" ref={activityRef} tabIndex={-1}>
          <ConversionProgress job={job} jobId={jobs.selectedId} upload={jobs.upload} voices={discovery.voices} pollError={jobs.pollError} pollPaused={jobs.pollPaused} cancelling={!!jobs.cancellingId} onResume={jobs.resumePolling} onAbortUpload={jobs.abortUpload} onCancel={() => void jobs.cancelJob()} onBackground={newConversion} />
          {job && <ConversionResult job={job} voice={discovery.voices.find((voice) => voice.id === job.voice)} onReuse={() => reuseJob(job)} onPlay={samples.stop} />}
        </div>

        <RecentConversions jobs={jobs.jobs} voices={discovery.voices} selectedId={jobs.selectedId} loading={jobs.historyLoading} error={jobs.historyError} locked={!!jobs.upload} deletingId={jobs.deletingId} onRefresh={jobs.refreshHistory} onView={viewJob} onReuse={reuseJob} onDelete={(next) => void jobs.removeJob(next, sources.forgetSaved)} />
        <footer className="studio-footer"><span><Icon name="shield" /> Conversion runs on your configured backend.</span><span>Initial model and reference preparation may need internet. Use media you have permission to edit.</span></footer>
      </main>
    </div>
  );
}