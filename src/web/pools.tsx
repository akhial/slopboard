// Compact weekly quota pool strip: how much fuel is left in each shared tank,
// how fast we are burning through it (%/h), and a mini recorded + projected line.

import { useRef, useState } from "react";
import type { Board, PoolPoint, PoolStatus } from "../shared/api.ts";
import { providerLabel } from "./data.ts";
import { clockFor } from "./format.ts";
import { Num, SectionHead, useSize } from "./ui.tsx";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

interface Mood {
  emoji: string;
  label: string;
  tone: "hot" | "warm" | "cool" | "dry";
}

function moodOf(pool: PoolStatus, nowMs: number): Mood {
  const fill = pool.capacity > 0 ? pool.remaining / pool.capacity : 0;
  const burnPerAcct = pool.burnPerHour !== null && pool.accounts > 0 ? pool.burnPerHour / pool.accounts : 0;
  const emptyInMs = pool.emptyAt ? Date.parse(pool.emptyAt) - nowMs : null;

  if (pool.remaining <= 0.5) return { emoji: "🪦", label: "Bone dry", tone: "dry" };
  if (fill <= 0.12 || (emptyInMs !== null && emptyInMs <= 12 * HOUR_MS)) {
    return { emoji: "🚨", label: "Fumes only", tone: "dry" };
  }
  if (emptyInMs !== null && emptyInMs <= 36 * HOUR_MS) {
    return { emoji: "🔥", label: "Running hot", tone: "hot" };
  }
  if (burnPerAcct >= 2.5) return { emoji: "🏎️", label: "Pedal down", tone: "hot" };
  if (burnPerAcct >= 0.7) return { emoji: "☕", label: "Steady sip", tone: "warm" };
  if (burnPerAcct > 0.08) return { emoji: "✈️", label: "Cruising", tone: "cool" };
  return { emoji: "🧊", label: "Ice cold", tone: "cool" };
}

function formatPct(value: number): string {
  return `${Math.round(value)}%`;
}

function formatBurn(value: number): string {
  if (value <= 0) return "0%/h";
  if (value < 0.1) return "<0.1%/h";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%/h`;
}

interface ParsedPoint {
  t: number;
  v: number;
  projected: boolean;
}

function PoolSparkline({ pool, nowMs, timezone }: { pool: PoolStatus; nowMs: number; timezone: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const { width } = useSize(wrap);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const rec: ParsedPoint[] = pool.recorded.map((p: PoolPoint) => ({ t: Date.parse(p.at), v: p.remaining, projected: false }));
  const proj: ParsedPoint[] = pool.projected.map((p: PoolPoint) => ({ t: Date.parse(p.at), v: p.remaining, projected: true }));
  const all = [...rec, ...proj];
  if (all.length < 2) return null;

  const minT = Math.min(...all.map((p) => p.t), nowMs - 3 * DAY_MS);
  const maxT = Math.max(...all.map((p) => p.t), nowMs + 4 * DAY_MS);
  const spanT = Math.max(1, maxT - minT);
  const yMax = Math.max(1, pool.capacity);

  const h = 56;
  const padX = 2;
  const padTop = 6;
  const padBot = 4;
  const innerW = Math.max(10, width - padX * 2);
  const innerH = h - padTop - padBot;

  const xOf = (t: number) => padX + ((t - minT) / spanT) * innerW;
  const yOf = (v: number) => padTop + innerH - (Math.min(yMax, Math.max(0, v)) / yMax) * innerH;

  const toPath = (pts: readonly ParsedPoint[]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.t).toFixed(1)} ${yOf(p.v).toFixed(1)}`).join(" ");

  const recPath = rec.length >= 2 ? toPath(rec) : "";
  const recArea =
    rec.length >= 2
      ? `${recPath} L${xOf(rec[rec.length - 1]!.t).toFixed(1)} ${(padTop + innerH).toFixed(1)} L${xOf(rec[0]!.t).toFixed(1)} ${(padTop + innerH).toFixed(1)} Z`
      : "";
  const projPath = proj.length >= 2 ? toPath(proj) : "";
  const nowX = xOf(nowMs);
  const nowY = yOf(pool.remaining);

  const onMove = (clientX: number) => {
    const el = wrap.current;
    if (!el || width <= 0) return;
    const rect = el.getBoundingClientRect();
    const relX = clientX - rect.left;
    const targetT = minT + ((relX - padX) / innerW) * spanT;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < all.length; i++) {
      const d = Math.abs(all[i]!.t - targetT);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    setHoverIdx(best);
  };

  const active = hoverIdx !== null ? all[hoverIdx] ?? null : null;
  const clock = clockFor(timezone);
  const activeX = active ? xOf(active.t) : 0;
  const tipAlign = activeX > width * 0.62 ? "is-left" : "is-right";

  return (
    <div
      ref={wrap}
      className="pool-spark"
      onPointerMove={(e) => onMove(e.clientX)}
      onPointerLeave={() => setHoverIdx(null)}
    >
      {width > 0 ? (
        <svg width={width} height={h} role="img" aria-label={`${providerLabel(pool.provider)} quota trajectory: ${formatPct(pool.remaining)} of ${formatPct(pool.capacity)} available now.`}>
          <line className="pool-baseline" x1={padX} x2={width - padX} y1={padTop + innerH} y2={padTop + innerH} />
          <line className="pool-now-line" x1={nowX} x2={nowX} y1={padTop} y2={padTop + innerH} />
          {recArea ? <path d={recArea} className="pool-area" /> : null}
          {recPath ? <path d={recPath} className="pool-line" /> : null}
          {projPath ? <path d={projPath} className="pool-line is-projected" /> : null}
          <circle cx={nowX} cy={nowY} r={3.5} className="pool-now-dot" />
          {active ? (
            <circle cx={xOf(active.t)} cy={yOf(active.v)} r={3.5} className="pool-hover-dot" />
          ) : null}
        </svg>
      ) : (
        <div style={{ height: h }} />
      )}
      {active ? (
        <div className={`pool-tip ${tipAlign}`} style={{ left: Math.min(Math.max(activeX, 4), Math.max(4, width - 4)) }}>
          <b>{formatPct(active.v)}</b>
          <span>
            {active.projected ? "est · " : ""}
            {clock.dayTime(active.t)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function PoolCard({ pool, nowMs, timezone }: { pool: PoolStatus; nowMs: number; timezone: string }) {
  const mood = moodOf(pool, nowMs);
  const fillPct = pool.capacity > 0 ? Math.min(100, Math.max(0, (pool.remaining / pool.capacity) * 100)) : 0;
  const clock = clockFor(timezone);
  const emptyInMs = pool.emptyAt ? Date.parse(pool.emptyAt) - nowMs : null;
  const emptySoon = emptyInMs !== null && emptyInMs > 0 && emptyInMs <= 48 * HOUR_MS;

  return (
    <article className={`pool-card tone-${mood.tone}`} data-provider={pool.provider}>
      <header className="pool-head">
        <div className="pool-who">
          <span className="provider-dot" aria-hidden="true" />
          <h3>{providerLabel(pool.provider)}</h3>
          <span className="pool-accts">
            {pool.accounts} {pool.accounts === 1 ? "acct" : "accts"}
          </span>
        </div>
        <span className={`pool-mood tone-${mood.tone}`}>
          <span className="emoji" aria-hidden="true">
            {mood.emoji}
          </span>{" "}
          {mood.label}
        </span>
      </header>

      <div className="pool-metrics">
        <div className="pool-avail">
          <span className="pool-label">Pool available</span>
          <p className="pool-big">
            <Num value={pool.remaining} format={formatPct} />
            <small>of {formatPct(pool.capacity)}</small>
          </p>
        </div>
        <div className="pool-burn">
          <span className="pool-label">Burn · 6h</span>
          <p className="pool-rate">
            {pool.burnPerHour !== null ? <Num value={pool.burnPerHour} format={formatBurn} /> : "–"}
          </p>
        </div>
      </div>

      <div className="pool-meter" role="progressbar" aria-valuenow={Math.round(pool.remaining)} aria-valuemin={0} aria-valuemax={Math.round(pool.capacity)} aria-label={`${providerLabel(pool.provider)} pool available`}>
        <i style={{ width: `${fillPct}%` }} />
      </div>

      <PoolSparkline pool={pool} nowMs={nowMs} timezone={timezone} />

      <footer className="pool-foot">
        {emptySoon && pool.emptyAt ? (
          <span className="pool-warn">Empty {clock.dayTime(pool.emptyAt)}</span>
        ) : pool.nextResetAt && pool.nextResetAmount ? (
          <span>
            Next refill <b>+{Math.round(pool.nextResetAmount)}%</b> {clock.dayTime(pool.nextResetAt)}
          </span>
        ) : (
          <span>Recorded 3d · projected 4d</span>
        )}
        <span className="pool-legend" aria-hidden="true">
          <i className="pool-swatch is-solid" /> past
          <i className="pool-swatch is-dashed" /> est
        </span>
      </footer>
    </article>
  );
}

/** Compact live quota tank & burn strip across shared provider pools. */
export function PoolStrip({ board }: { board: Board }) {
  if (board.pools.length === 0) return null;
  const nowMs = Date.parse(board.generatedAt) || Date.now();
  return (
    <section className="pools" aria-labelledby="pools-title">
      <SectionHead
        id="pools-title"
        title="Fuel in the"
        mark="tanks"
        note="Live weekly quota left across the shared pool, and how fast we're burning through it right now."
      />
      <div className={`pool-grid count-${Math.min(3, board.pools.length)}`}>
        {board.pools.map((pool) => (
          <PoolCard key={pool.provider} pool={pool} nowMs={nowMs} timezone={board.timezone} />
        ))}
      </div>
    </section>
  );
}
