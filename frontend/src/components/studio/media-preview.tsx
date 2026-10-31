import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { MediaKind } from "@/lib/studio-types";
import { pauseMedia } from "@/lib/studio-utils";
import { Icon, Waveform } from "./icon";

interface Props {
  src: string;
  kind: MediaKind;
  label: string;
  limitSeconds?: number;
  onPlay: () => void;
  compact?: boolean;
}

export function MediaPreview({ src, kind, label, limitSeconds, onPlay, compact = false }: Props) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const media = useRef<HTMLMediaElement | null>(null);

  useEffect(() => {
    const player = media.current;
    return () => { player?.pause(); };
  }, [failed, attempt]);

  function handlePlay(event: SyntheticEvent<HTMLMediaElement>) {
    const player = event.currentTarget;
    if (limitSeconds && player.currentTime >= limitSeconds) player.currentTime = 0;
    pauseMedia(player);
    onPlay();
  }

  function limitPlayback(event: SyntheticEvent<HTMLMediaElement>) {
    const player = event.currentTarget;
    if (limitSeconds && player.currentTime >= limitSeconds) {
      player.pause();
      if (player.currentTime > limitSeconds) player.currentTime = limitSeconds;
    }
  }

  const common = {
    ref: (element: HTMLMediaElement | null) => { media.current = element; },
    src: limitSeconds ? `${src}#t=0,${limitSeconds}` : src,
    controls: true,
    preload: "metadata" as const,
    onPlay: handlePlay,
    onTimeUpdate: limitPlayback,
    onSeeking: limitPlayback,
    onError: () => setFailed(true),
    "aria-label": label,
  };

  return (
    <div className={`media-player ${compact ? "media-player--compact" : ""}`}>
      {failed ? (
        <div className="media-fallback" role="status">
          <Icon name={kind === "video" ? "video" : "audio"} />
          <p>This browser cannot preview this media. You can still convert it or download the finished export.</p>
          <button type="button" className="text-button" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }}>Retry playback</button>
        </div>
      ) : kind === "video" ? (
        <video key={attempt} {...common} playsInline>Your browser does not support video playback.</video>
      ) : (
        <>
          {!compact && <div className="audio-art"><Icon name="headphones" /><Waveform /></div>}
          <audio key={attempt} {...common}>Your browser does not support audio playback.</audio>
        </>
      )}
    </div>
  );
}