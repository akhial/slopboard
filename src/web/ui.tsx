// Small building blocks shared by the sections.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import type { Board, PersonRow, RangeKey, TokenCounts } from "../shared/api.ts";
import { colourOf, initials } from "./colors.ts";
import { compact, full, pct } from "./format.ts";

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A number that glides to its new value instead of jumping. The first paint always shows the
 * true value: only later changes (a refresh, another range) are animated, so the page never
 * shows a half-counted total. The text is written straight to the DOM while it moves, so a
 * refresh never re-renders the tree sixty times a second.
 */
export function Num({ value, format = compact, className }: { value: number; format?: (n: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current ?? value;
    if (from === value || reducedMotion() || document.hidden) {
      shown.current = value;
      el.textContent = format(value);
      return;
    }
    const start = performance.now();
    const length = 700;
    let frame = requestAnimationFrame(function step(now) {
      const k = Math.min(1, (now - start) / length);
      const eased = 1 - Math.pow(1 - k, 3);
      const v = k === 1 ? value : from + (value - from) * eased;
      shown.current = v;
      el.textContent = format(v);
      if (k < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, format]);
  return (
    <span ref={ref} className={className} title={full(value)}>
      {format(shown.current ?? value)}
    </span>
  );
}

/** Lookup of people by id. Board.people lists everyone, so every id on the board resolves here. */
export interface Cast {
  get(id: string | null | undefined): PersonRow | undefined;
  name(id: string | null | undefined): string;
  /** True for the shared key, and for an id that is not on the list at all. */
  ghost(id: string | null | undefined): boolean;
}

export function castOf(board: Board): Cast {
  const byId = new Map<string, PersonRow>();
  for (const p of board.people) byId.set(p.id, p);
  const get = (id: string | null | undefined) => (id ? byId.get(id) : undefined);
  return {
    get,
    name: (id) => (id ? (byId.get(id)?.name ?? id) : "nobody"),
    ghost: (id) => get(id)?.unassigned ?? true,
  };
}

/**
 * On the board means: a real person with tokens in this range. Having a key is not enough, and
 * neither is the shared key's traffic. Only these people get a place, a podium step, a rank
 * movement and a mention in the tab title.
 */
export function onBoard(person: PersonRow): boolean {
  return !person.unassigned && person.tokens.total > 0;
}

/** The people on the board, best first (the server already sorts them). */
export function contenders(board: Board): PersonRow[] {
  return board.people.filter(onBoard);
}

export function personStyle(id: string | null | undefined): CSSProperties {
  return { "--pc": colourOf(id) } as CSSProperties;
}

export function Avatar({ id, name, ghost = false, className = "" }: { id: string; name: string; ghost?: boolean; className?: string }) {
  return (
    <span className={`avatar ${ghost ? "is-ghost" : ""} ${className}`} style={personStyle(id)} aria-hidden="true">
      {ghost ? "?" : initials(name)}
    </span>
  );
}

/** Coloured name chip, used wherever a person is mentioned outside the leaderboard. */
export function Who({ id, cast, className = "" }: { id: string | null | undefined; cast: Cast; className?: string }) {
  return (
    <span className={`who ${cast.ghost(id) ? "is-ghost" : ""} ${className}`} style={personStyle(id)}>
      <i className="who-dot" aria-hidden="true" />
      <span className="who-name">{cast.name(id)}</span>
    </span>
  );
}

export const TOKEN_KINDS: readonly { key: "input" | "cacheRead" | "cacheWrite" | "output"; label: string; short: string; hint: string }[] = [
  { key: "input", label: "Fresh input", short: "in", hint: "Prompt tokens that missed the cache" },
  { key: "cacheRead", label: "Cache read", short: "cache rd", hint: "Prompt tokens recycled from cache" },
  { key: "cacheWrite", label: "Cache write", short: "cache wr", hint: "Prompt tokens written into the cache" },
  { key: "output", label: "Output", short: "out", hint: "Model output tokens, reasoning included" },
];

/** One bar split into input / cache read / cache write / output. Texture means token kind, never a person. */
export function SplitBar({ tokens, className = "" }: { tokens: TokenCounts; className?: string }) {
  const sum = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
  const label = TOKEN_KINDS.map((k) => `${k.label} ${compact(tokens[k.key])}`).join(", ");
  return (
    <span className={`split ${className}`} role="img" aria-label={label} title={label}>
      {sum > 0 ? (
        TOKEN_KINDS.map((k) => (tokens[k.key] > 0 ? <i key={k.key} className={`seg seg-${k.key}`} style={{ flexGrow: tokens[k.key] / sum }} /> : null))
      ) : (
        <i className="seg seg-none" style={{ flexGrow: 1 }} />
      )}
    </span>
  );
}

export function SplitLegend({ tokens, className = "" }: { tokens: TokenCounts; className?: string }) {
  const sum = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
  return (
    <dl className={`split-legend ${className}`}>
      {TOKEN_KINDS.map((k) => (
        <div key={k.key} title={`${k.hint}: ${full(tokens[k.key])}`}>
          <dt>
            <i className={`swatch seg-${k.key}`} aria-hidden="true" />
            {k.label}
          </dt>
          <dd>
            <Num value={tokens[k.key]} />
            <small>{sum > 0 ? pct(tokens[k.key] / sum) : "–"}</small>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Tiny bar chart of one person's tokens per bucket. */
export function Spark({ values, id, className = "" }: { values: readonly number[]; id: string; className?: string }) {
  const n = values.length;
  const max = Math.max(1, ...values);
  const w = 100;
  const h = 32;
  if (n === 0) return <svg className={`spark ${className}`} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" />;
  const dense = n > 40;
  const step = w / n;
  let area = `M0 ${h}`;
  if (dense) {
    values.forEach((v, i) => {
      area += ` L${(i * step).toFixed(2)} ${(h - (v / max) * (h - 2)).toFixed(2)} L${((i + 1) * step).toFixed(2)} ${(h - (v / max) * (h - 2)).toFixed(2)}`;
    });
    area += ` L${w} ${h} Z`;
  }
  return (
    <svg className={`spark ${className}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={personStyle(id)} aria-hidden="true">
      {dense ? (
        <path d={area} className="spark-fill" />
      ) : (
        values.map((v, i) => {
          const bar = v > 0 ? Math.max(1.5, (v / max) * (h - 1)) : 0.8;
          const gap = Math.min(1.2, step * 0.18);
          return <rect key={i} x={i * step + gap / 2} y={h - bar} width={Math.max(0.5, step - gap)} height={bar} className={v > 0 ? "spark-fill" : "spark-zero"} />;
        })
      )}
    </svg>
  );
}

export type Movement = { kind: "up" | "down" | "same" | "new" | "none"; by: number };

/**
 * Movement since the preceding window, straight from the server's ranks (both are counted among
 * assigned people only). Nobody moves unless they are on the board now.
 */
export function movementOf(person: PersonRow, range: RangeKey): Movement {
  if (!onBoard(person) || range === "all") return { kind: "none", by: 0 };
  if (person.previousRank === null) return { kind: "new", by: 0 };
  const delta = person.previousRank - person.rank;
  return { kind: delta > 0 ? "up" : delta < 0 ? "down" : "same", by: Math.abs(delta) };
}

export function Move({ movement, previous }: { movement: Movement; previous: string }) {
  if (movement.kind === "none") return null;
  const text = {
    up: `Up ${movement.by} from ${previous}`,
    down: `Down ${movement.by} from ${previous}`,
    same: `Holding steady since ${previous}`,
    new: `Fresh on the board (absent ${previous})`,
    none: "",
  }[movement.kind];
  return (
    <span className={`move move-${movement.kind}`} title={text}>
      <span aria-hidden="true">{movement.kind === "up" ? `↑${movement.by}` : movement.kind === "down" ? `↓${movement.by}` : movement.kind === "new" ? "NEW" : "="}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

/** A section title: plain words, then one scribbled in brush script. */
export function SectionHead({ id, title, mark, note, children }: { id: string; title: string; mark: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <header className="section-head">
      <h2 id={id}>
        {title} <em className="scrawl">{mark}</em>
      </h2>
      {note ? <p className="section-note">{note}</p> : null}
      {children}
    </header>
  );
}

/** Pixel size of an element plus the current root font size, for charts drawn to measure. */
export function useSize(ref: RefObject<HTMLElement | null>): { width: number; rem: number } {
  const [size, setSize] = useState({ width: 0, rem: 16 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const width = Math.round(el.clientWidth);
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setSize((s) => (s.width === width && s.rem === rem ? s : { width, rem }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
