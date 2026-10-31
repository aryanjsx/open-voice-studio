import { useState } from "react";
import { useFavorites } from "@/hooks/use-favorites";
import type { SampleState } from "@/hooks/use-voice-samples";
import type { Voice } from "@/lib/studio-types";
import { clampPercent } from "@/lib/studio-utils";
import { Icon, Spinner, Waveform } from "./icon";

interface Props {
  voices: Voice[];
  selected: string;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  sample: SampleState;
  onSelect: (id: string) => void;
  onSample: (voice: Voice) => void;
  onStopSample: () => void;
  onReload: () => void;
}

export function VoiceLibrary({ voices, selected, loading, error, disabled, sample, onSelect, onSample, onStopSample, onReload }: Props) {
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState("all");
  const [accent, setAccent] = useState("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const { favorites, toggle } = useFavorites();
  const accents = [...new Set(voices.map((voice) => voice.accent))].sort();
  const term = query.trim().toLocaleLowerCase();
  const filtered = voices.filter((voice) =>
    `${voice.name} ${voice.style} ${voice.accent} ${voice.description}`.toLocaleLowerCase().includes(term)
    && (gender === "all" || voice.gender === gender)
    && (accent === "all" || voice.accent === accent)
    && (!favoritesOnly || favorites.includes(voice.id)),
  );
  const selectedVoice = voices.find((voice) => voice.id === selected);
  const selectedHidden = selectedVoice && !filtered.some((voice) => voice.id === selected);
  const playingVoice = voices.find((voice) => voice.id === sample.voiceId);
  const hasFilter = !!query || gender !== "all" || accent !== "all" || favoritesOnly;
  function clearFilters() { setQuery(""); setGender("all"); setAccent("all"); setFavoritesOnly(false); }

  return (
    <section className="panel library-panel" aria-labelledby="voice-library-heading">
      <div className="section-heading library-heading">
        <div><span className="eyebrow accent-text">Find your sound</span><h2 id="voice-library-heading">The voice library <span className="count-badge">{voices.length || "—"}</span></h2></div>
        <button type="button" className="icon-button" onClick={onReload} disabled={loading} aria-label="Reload voices and engine status" title="Reload voices"><Icon name="refresh" className={loading ? "spin" : ""} /></button>
      </div>
      <p className="section-description">A different character for every story. Listen first, then choose.</p>
      <label className="search-field"><Icon name="search" /><span className="sr-only">Search voices by name, style or accent</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search voices, styles, accents…" /></label>
      <div className="library-filters">
        <label><span className="sr-only">Filter by gender</span><select value={gender} onChange={(event) => setGender(event.target.value)}><option value="all">All genders</option><option value="male">Male</option><option value="female">Female</option></select></label>
        <label><span className="sr-only">Filter by accent</span><select value={accent} onChange={(event) => setAccent(event.target.value)}><option value="all">All accents</option>{accents.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <button type="button" className={`filter-button ${favoritesOnly ? "is-active" : ""}`} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}><Icon name="star" /> <span>Favorites</span></button>
      </div>
      {error && <div className="notice notice-error" role="alert"><p>{error}</p><button type="button" className="text-button" onClick={onReload} disabled={loading}>Retry discovery</button></div>}
      <div className="library-result-count"><span>{loading && !voices.length ? "Loading voice catalog…" : `${filtered.length} ${filtered.length === 1 ? "voice" : "voices"}`}</span>{hasFilter && <button type="button" className="text-button" onClick={clearFilters}>Clear filters</button>}</div>
      {selectedHidden && <p className="filter-selection-note" role="status">{selectedVoice.name} is still selected, even though these filters hide it.</p>}
      <div className="voice-grid" role="group" aria-label="Choose a conversion voice" aria-busy={loading && !voices.length}>
        {loading && !voices.length ? Array.from({ length: 8 }, (_, index) => <div key={index} className="voice-skeleton" aria-hidden="true"><div /><span /><span /></div>) : filtered.map((voice) => {
          const chosen = selected === voice.id;
          const favorite = favorites.includes(voice.id);
          const activeSample = sample.voiceId === voice.id && (sample.phase === "loading" || sample.phase === "playing");
          const preparing = activeSample && sample.phase === "loading";
          return (
            <div key={voice.id} className={`voice-card ${chosen ? "is-selected" : ""}`} data-color={voice.color}>
              <label className={`voice-select ${disabled ? "selection-disabled" : ""}`}>
                <input type="radio" className="sr-only" name="studio-voice" value={voice.id} checked={chosen} disabled={disabled} onChange={() => onSelect(voice.id)} aria-label={`${voice.name}, ${voice.style}, ${voice.accent}, ${voice.gender}`} aria-describedby={`voice-description-${voice.id} voice-reference-${voice.id}`} />
                <span className="voice-topline"><span className="voice-avatar"><Icon name="wave" /></span><span className="voice-identity"><strong>{voice.name}</strong><span>{voice.style}</span></span></span>
                <span className="voice-tags"><span>{voice.accent}</span><span>{voice.gender === "male" ? "Male" : "Female"}</span><span className={`voice-check ${chosen ? "visible" : ""}`}><Icon name="check" /> Selected</span></span>
                <span className="voice-description" id={`voice-description-${voice.id}`}>{voice.description}</span>
                <span id={`voice-reference-${voice.id}`} className={`reference-badge ${voice.reference_ready ? "is-ready" : ""}`} title={voice.reference_ready ? "Conversion reference is prepared locally" : "Reference will be prepared on first conversion; internet may be needed"}><span className="status-dot" />{voice.reference_ready ? "Reference ready" : "Prepares on first use"}</span>
              </label>
              <button type="button" className={`icon-button favorite-button ${favorite ? "is-favorite" : ""}`} aria-pressed={favorite} aria-label={`${favorite ? "Remove" : "Add"} ${voice.name} ${favorite ? "from" : "to"} favorites`} title={favorite ? "Remove favorite" : "Save favorite"} onClick={() => toggle(voice.id)}><Icon name="star" /></button>
              <div className={`sample-controls ${activeSample ? "is-playing" : ""}`}>
                <button type="button" className="sample-button" aria-label={`${activeSample ? "Stop" : "Play"} ${voice.name}'s ${voice.sample_seconds}-second reference sample`} onClick={() => onSample(voice)}>
                  {preparing ? <Spinner /> : <Icon name={activeSample ? "stop" : "play"} />}<span>{preparing ? "Stop loading" : activeSample ? "Stop" : `Play ${voice.sample_seconds}s`}</span>
                </button>
                <div className="sample-visual">
                  <Waveform />
                  {activeSample && <div className="sample-progress" role="progressbar" aria-label={`${voice.name} sample playback`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={preparing ? undefined : clampPercent(sample.progress)}><span style={{ width: `${sample.progress}%` }} /></div>}
                </div>
              </div>
              {sample.voiceId === voice.id && sample.error && <p className="sample-error" role="alert">{sample.error}</p>}
            </div>
          );
        })}
      </div>
      {!loading && !filtered.length && <div className="empty-state"><Icon name={favoritesOnly ? "star" : "search"} /><h3>{voices.length ? "No matching voices" : "No voices available yet"}</h3><p>{voices.length ? "Try a different search, or save a few favorites." : "Reconnect to the backend and reload the voice catalog."}</p><button type="button" className="button button-secondary" onClick={voices.length ? clearFilters : onReload}>{voices.length ? "Clear filters" : "Reload voices"}</button></div>}
      <div className="sample-announcement" aria-live="polite" aria-atomic="true">
        {sample.phase === "loading" && <span>Preparing {playingVoice?.name ?? "voice"} sample. First-time preparation needs internet.</span>}
        {sample.phase === "playing" && <span>Playing {playingVoice?.name ?? "voice"} reference sample.</span>}
        {sample.voiceId && !filtered.some((voice) => voice.id === sample.voiceId) && (sample.phase === "loading" || sample.phase === "playing") && <button type="button" className="text-button" onClick={onStopSample}>Stop sample</button>}
        {sample.phase === "error" && !filtered.some((voice) => voice.id === sample.voiceId) && <span role="alert">{sample.error}</span>}
      </div>
      <div className="help-note sample-disclaimer"><Icon name="headphones" /><p>5-second reference TTS samples, not a preview of your upload. Converted speech may sound different. Samples prepare online once, then are cached locally. Accents describe the references; this is not translation.</p></div>
    </section>
  );
}