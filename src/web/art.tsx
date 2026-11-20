// The collage kit: line icons for the black buttons, hand-drawn doodles, grayscale photo cutouts
// and paper shapes. All decorative: every piece is aria-hidden, the words around it carry the
// meaning.

import type { CSSProperties, ReactNode } from "react";
import alarmClock from "./cutouts/alarm-clock.webp";
import catSunglasses from "./cutouts/cat-sunglasses.webp";
import cloche from "./cutouts/cloche.webp";
import coinStack from "./cutouts/coin-stack.webp";
import handCoin from "./cutouts/hand-coin.webp";
import handcuffs from "./cutouts/handcuffs.webp";
import match from "./cutouts/match.webp";
import megaphone from "./cutouts/megaphone.webp";
import meltingSmiley from "./cutouts/melting-smiley.webp";
import pig from "./cutouts/pig.webp";
import receipt from "./cutouts/receipt.webp";
import robot from "./cutouts/robot.webp";
import spool from "./cutouts/spool.webp";
import telephone from "./cutouts/telephone.webp";
import trophy from "./cutouts/trophy.webp";

// ---------- icons: 24px line icons, drawn in currentColor ----------

const ICONS = {
  plus: "M12 5v14M5 12h14",
  card: "M3 7.5A2.5 2.5 0 0 1 5.5 5h13A2.5 2.5 0 0 1 21 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5zM3 10h18",
  swap: "M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7",
  send: "M21 3 10 14M21 3l-7 18-4-7-7-4z",
  flame: "M12 22c4 0 7-2.7 7-6.8 0-3.6-2.4-5.9-4.3-8.2-.5 2.2-1.8 3.4-3 3.9C12 7.7 11 4.5 8.5 2 8.7 5.5 5 8.3 5 13.3 5 18.9 8 22 12 22z",
  receipt: "M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4",
  megaphone: "M3 10v4a1 1 0 0 0 1 1h3l8 5V4L7 9H4a1 1 0 0 0-1 1zM19 9a4 4 0 0 1 0 6",
  thread: "M4 5h16M4 12h16M4 19h10",
  robot: "M5 9h14v10H5zM12 5v4M9 13h.01M15 13h.01M9 16h6M3 13v3M21 13v3M12 3.5h.01",
  people: "M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 20v-1.5a3.5 3.5 0 0 0-2.5-3.4M15.5 4.1a3.5 3.5 0 0 1 0 6.8",
  down: "M12 4v16M5 13l7 7 7-7",
  up: "M12 20V4M5 11l7-7 7 7",
  recycle: "M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  chevron: "M9 6l6 6-6 6",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  auto: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 3v18",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

/** The black round button the icons sit in. */
export function IconDisc({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <span className={`disc ${className}`} aria-hidden="true">
      <Icon name={name} />
    </span>
  );
}

// ---------- doodles: marker strokes, drawn in currentColor ----------

const DOODLES = {
  /** Three short strokes fanning out, the "//" next to things that are shouting. */
  ticks: { box: "0 0 40 40", d: "M6 30 13 12M17 34 25 18M28 36 37 26" },
  /** Two strokes, for a corner. */
  pair: { box: "0 0 40 40", d: "M8 30 16 10M20 32 30 14" },
  /** A long hand-drawn arrow, pointing right. */
  arrow: { box: "0 0 120 40", d: "M4 26C30 20 62 16 112 18M96 6l16 12-17 12" },
  /** A loose crown. */
  crown: { box: "0 0 48 36", d: "M5 30 3 8l12 11L24 4l9 15 12-11-2 22z" },
  /** A scribbled loop, to circle something. */
  loop: { box: "0 0 120 60", d: "M18 40C4 30 14 10 50 7c38-3 66 9 62 24-4 17-46 25-78 19C8 45 6 30 30 22c22-7 60-6 80 3" },
  /** A smiley, no circle. */
  smiley: { box: "0 0 40 40", d: "M14 12v6M26 12v6M9 24c4 7 18 8 22 0" },
  /** An asterisk-ish sparkle. */
  sparkle: { box: "0 0 40 40", d: "M20 4v32M4 20h32M9 9l22 22M31 9 9 31" },
  /** A wavy underline. */
  squiggle: { box: "0 0 120 20", d: "M3 12c10-10 18 8 28 0s18-8 28 0 18 8 28 0 18-8 30 0" },
  /** An oval drawn round a word, not quite closed. */
  oval: { box: "0 0 120 60", d: "M70 6C30 4 6 16 6 31s24 25 58 24 52-12 50-27C112 12 90 4 52 8" },
} as const;

export type DoodleName = keyof typeof DOODLES;

export function Doodle({ name, className = "", style }: { name: DoodleName; className?: string; style?: CSSProperties }) {
  const { box, d } = DOODLES[name];
  return (
    <svg className={`doodle doodle-${name} ${className}`} viewBox={box} style={style} fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** A spiky starburst, filled, to pop a cutout off the card behind it. */
export function Burst({ className = "", style }: { className?: string; style?: CSSProperties }) {
  const spikes = 14;
  const points = Array.from({ length: spikes * 2 }, (_, i) => {
    const r = i % 2 === 0 ? 48 : 31 + ((i * 7) % 5);
    const a = (Math.PI * i) / spikes;
    return `${(50 + r * Math.cos(a)).toFixed(1)},${(50 + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
  return (
    <svg className={`burst ${className}`} viewBox="0 0 100 100" style={style} aria-hidden="true">
      <polygon points={points} fill="currentColor" />
    </svg>
  );
}

// ---------- cutouts: grayscale photos clipped out of a magazine ----------

export const CUTOUTS = {
  "alarm-clock": alarmClock,
  "cat-sunglasses": catSunglasses,
  cloche,
  "coin-stack": coinStack,
  "hand-coin": handCoin,
  handcuffs,
  match,
  megaphone,
  "melting-smiley": meltingSmiley,
  pig,
  receipt,
  robot,
  spool,
  telephone,
  trophy,
} as const;

export type CutoutName = keyof typeof CUTOUTS;

export function Cutout({ name, className = "", style }: { name: CutoutName; className?: string; style?: CSSProperties }) {
  return <img className={`cutout cutout-${name} ${className}`} src={CUTOUTS[name]} style={style} alt="" aria-hidden="true" draggable={false} decoding="async" />;
}

// ---------- paper ----------

/** A scrap of black paper with torn edges and marker writing on it. */
export function TornNote({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`torn ${className}`}>{children}</p>;
}

/** A sticky note with its corner folded over. */
export function StickyNote({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`sticky ${className}`}>{children}</p>;
}

/** A ticket with zigzag ends. */
export function Ticket({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`ticket ${className}`}>{children}</p>;
}
