import type { SVGProps } from "react";

const shapes = {
  wave: <path d="M3 10v4m4-8v12m5-16v20m5-17v14m4-10v6" />,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></>,
  audio: <><path d="M9 18V5l12-2v13M9 8l12-2" /><ellipse cx="6" cy="18" rx="3" ry="3" /><ellipse cx="18" cy="16" rx="3" ry="3" /></>,
  video: <><rect x="3" y="5" width="13" height="14" rx="3" /><path d="m16 9 5-3v12l-5-3" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  play: <path d="m9 5 11 7-11 7Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  download: <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 6a8 8 0 0 1 13.4 3M4.5 15A8 8 0 0 0 18 18" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7Z" />,
  sliders: <><path d="M4 7h3m4 0h9M4 17h9m4 0h3" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></>,
  cpu: <><rect x="5" y="5" width="14" height="14" rx="3" /><path d="M9 9h6v6H9ZM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3" /></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
  reuse: <><path d="M8 3 4 7l4 4M4 7h10a6 6 0 0 1 0 12h-2" /><path d="M7 15v6m-3-3h6" /></>,
  headphones: <><path d="M4 14v-3a8 8 0 0 1 16 0v3" /><rect x="3" y="12" width="5" height="9" rx="2" /><rect x="16" y="12" width="5" height="9" rx="2" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" /></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
};

export function Icon({ name, className = "", ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof shapes }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={`icon ${className}`} aria-hidden="true" {...props}>
      {shapes[name]}
    </svg>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Waveform({ className = "" }: { className?: string }) {
  const heights = [20, 36, 24, 50, 76, 44, 64, 90, 58, 38, 70, 100, 62, 42, 84, 56, 32, 68, 46, 28, 54, 80, 48, 34, 60, 42, 24, 38];
  return <div className={`waveform ${className}`} aria-hidden="true">{heights.map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}</div>;
}