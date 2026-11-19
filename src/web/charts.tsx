// The two hand-drawn charts: usage over time per person, and the weekday-by-hour heatmap.

import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Board, HeatCell } from "../shared/api.ts";
import { colourOf } from "./colors.ts";
import { clockFor, compact, full, hourLabel, WEEKDAYS } from "./format.ts";
import { castOf, personStyle, SectionHead, useSize } from "./ui.tsx";

/** Smallest "round" number at or above the value, so the axis ends on a readable label. */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(value)));
  for (const m of [1, 1.5, 2, 3, 4, 5, 6, 8, 10]) {
    if (m * power >= value) return m * power;
  }
  return 10 * power;
}

export function Timeline({ board }: { board: Board }) {
  const wrap = useRef<HTMLDivElement>(null);
  const { width, rem } = useSize(wrap);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<number | null>(null);
  const cast = castOf(board);
  const clock = clockFor(board.timezone);
  const { buckets, series, unit } = board.timeline;
  const n = buckets.length;

  // Stack in leaderboard order, biggest at the bottom. People with nothing in the range have a
  // series of zeros, which would only add dead chips to the legend.
  const hasTokens = (id: string) => (series[id] ?? []).some((v) => v > 0);
  const ids = board.people.map((p) => p.id).filter(hasTokens);
  for (const id of Object.keys(series)) if (!ids.includes(id) && hasTokens(id)) ids.push(id);
  const visible = ids.filter((id) => !hidden.has(id));
  const at = (id: string, i: number) => series[id]?.[i] ?? 0;
  const totals = buckets.map((_, i) => visible.reduce((sum, id) => sum + at(id, i), 0));
  const personTotals = new Map(ids.map((id) => [id, (series[id] ?? []).reduce((a, b) => a + b, 0)]));
  const top = niceCeil(Math.max(0, ...totals));
  const anything = totals.some((t) => t > 0);

  // Long day ranges only show the day of the month, so they get a second row naming the months.
  const months = unit === "day" && n > 10;
  const height = Math.round(rem * (months ? 21 : 20));
  const pad = { left: rem * 3.3, right: rem * 0.4, top: rem * 0.7, bottom: rem * (months ? 2.9 : 1.9) };
  const innerW = Math.max(10, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const step = n > 0 ? innerW / n : innerW;
  const barW = Math.max(1, Math.min(step * 0.8, rem * 4.5));
  const outlined = barW >= 5;
  const y = (v: number) => pad.top + innerH - (v / top) * innerH;
  const ticks = [0.25, 0.5, 0.75, 1].map((f) => top * f);

  const short = (iso: string) => (unit === "hour" ? clock.time(iso).slice(0, 2) : n <= 10 ? `${clock.weekday(iso)} ${clock.dayOfMonth(iso)}` : clock.dayOfMonth(iso));
  const long = (iso: string) => (unit === "hour" ? `${clock.weekday(iso)} ${clock.time(iso)}–${clock.time(new Date(iso).getTime() + 3_600_000)}` : clock.date(iso));
  const labelWidth = rem * (unit === "hour" || n > 10 ? 1.9 : 3.6);
  const every = Math.max(1, Math.ceil(labelWidth / step));

  const peak = totals.indexOf(Math.max(...totals, 0));
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (n === 0) return;
    const current = active ?? (event.key === "ArrowLeft" ? n : -1);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = Math.min(n - 1, current + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = n - 1;
    else if (event.key === "Escape") {
      setActive(null);
      return;
    } else return;
    event.preventDefault();
    setActive(next);
  };

  const toggle = (id: string) =>
    setHidden((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const activeIso = active !== null ? buckets[active] : undefined;
  const tipRows = active === null ? [] : visible.map((id) => ({ id, value: at(id, active) })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const tipX = active === null ? 0 : pad.left + step * (active + 0.5);
  const tipSide = tipX > width / 2 ? "left" : "right";

  return (
    <section className="timeline panel" aria-labelledby="timeline-title">
      <SectionHead id="timeline-title" title="Damage over" mark="time" note={`Tokens per ${unit}, stacked by suspect. ${unit === "hour" ? "The current hour is still unfolding." : "Today is still unfolding."}`} />
      <div className="legend" role="group" aria-label="Show or hide people">
        {ids.map((id) => (
          <button key={id} type="button" className="legend-chip" style={personStyle(id)} aria-pressed={!hidden.has(id)} onClick={() => toggle(id)} title={hidden.has(id) ? "Put back on the chart" : "Hide from chart"}>
            <i className="who-dot" aria-hidden="true" />
            {cast.name(id)}
            <small>{compact(personTotals.get(id) ?? 0)}</small>
          </button>
        ))}
      </div>
      <div
        ref={wrap}
        className="chart"
        tabIndex={0}
        role="group"
        aria-label={`Tokens per ${unit}. ${anything && peak >= 0 && buckets[peak] ? `Busiest ${unit}: ${long(buckets[peak])} with ${compact(totals[peak] ?? 0)} tokens.` : "No tokens yet."} Use the arrow keys to step through.`}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        {width > 0 ? (
          <svg width={width} height={height} role="presentation">
            {ticks.map((t) => (
              <g key={t}>
                <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
                <text className="axis-text" x={pad.left - rem * 0.5} y={y(t)} textAnchor="end" dominantBaseline="middle">
                  {compact(t)}
                </text>
              </g>
            ))}
            {buckets.map((iso, i) => {
              const cx = pad.left + step * (i + 0.5);
              let acc = 0;
              return (
                <g key={iso} className={active === i ? "bar is-active" : active === null ? "bar" : "bar is-dim"}>
                  {visible.map((id) => {
                    const v = at(id, i);
                    if (v <= 0) return null;
                    const y1 = y(acc + v);
                    const h = y(acc) - y1;
                    acc += v;
                    return <rect key={id} x={cx - barW / 2} y={y1} width={barW} height={Math.max(0.5, h)} fill={colourOf(id)} className={outlined ? "bar-seg" : "bar-seg is-thin"} />;
                  })}
                  {(i % every === 0 && n - 1 - i >= every * 0.6) || i === n - 1 ? (
                    <text className={i === n - 1 ? "axis-text is-now" : "axis-text"} x={cx} y={height - pad.bottom + rem * 1.15} textAnchor="middle">
                      {short(iso)}
                    </text>
                  ) : null}
                  {months && (i === 0 || clock.month(iso) !== clock.month(buckets[i - 1] ?? iso)) ? (
                    <g>
                      <line className="month-tick" x1={pad.left + step * i} x2={pad.left + step * i} y1={y(0)} y2={height - rem * 0.3} />
                      <text className="axis-text is-month" x={pad.left + step * i + rem * 0.35} y={height - rem * 0.55}>
                        {clock.month(iso)}
                      </text>
                    </g>
                  ) : null}
                  <rect className="bar-hit" x={pad.left + step * i} y={pad.top} width={step} height={innerH + pad.bottom} onPointerEnter={() => setActive(i)} onPointerDown={() => setActive(i)} />
                </g>
              );
            })}
            <line className="axis-line" x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} />
          </svg>
        ) : (
          <div style={{ height }} />
        )}
        {!anything && width > 0 ? <p className="chart-empty">Flatline. The bars will appear the second someone caves.</p> : null}
        {active !== null && activeIso ? (
          <div className={`tip tip-${tipSide}`} style={tipSide === "right" ? { left: tipX } : { right: width - tipX }} role="status">
            <p className="tip-title">{long(activeIso)}</p>
            {tipRows.length > 0 ? (
              <ul>
                {tipRows.map((r) => (
                  <li key={r.id} style={personStyle(r.id)}>
                    <i className="who-dot" aria-hidden="true" />
                    <span>{cast.name(r.id)}</span>
                    <b>{compact(r.value)}</b>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="tip-none">Mercifully quiet.</p>
            )}
            {tipRows.length > 1 ? (
              <p className="tip-total">
                <span>Total</span>
                <b>{compact(totals[active] ?? 0)}</b>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

// Pale straw through orange to a deep burnt plum: readable as "more" without borrowing anyone's colour.
const HEAT_STOPS: readonly (readonly [number, number, number])[] = [
  [253, 243, 208],
  [255, 215, 106],
  [255, 150, 56],
  [228, 54, 42],
  [110, 18, 40],
];

function heatColour(level: number): string {
  const clamped = Math.max(0, Math.min(1, level));
  const pos = clamped * (HEAT_STOPS.length - 1);
  const i = Math.min(HEAT_STOPS.length - 2, Math.floor(pos));
  const a = HEAT_STOPS[i] ?? [0, 0, 0];
  const b = HEAT_STOPS[i + 1] ?? a;
  const k = pos - i;
  const mix = (j: 0 | 1 | 2) => Math.round(a[j] + (b[j] - a[j]) * k);
  return `rgb(${mix(0)} ${mix(1)} ${mix(2)})`;
}

export function Heatmap({ board }: { board: Board }) {
  const [picked, setPicked] = useState<number | null>(null);
  const cells = new Map<number, HeatCell>();
  let max = 0;
  let peakKey: number | null = null;
  for (const cell of board.heatmap) {
    if (cell.weekday < 0 || cell.weekday > 6 || cell.hour < 0 || cell.hour > 23) continue;
    const key = cell.weekday * 24 + cell.hour;
    cells.set(key, cell);
    if (cell.tokens > max) {
      max = cell.tokens;
      peakKey = key;
    }
  }
  const describe = (key: number) => {
    const weekday = Math.floor(key / 24);
    const hour = key % 24;
    const cell = cells.get(key);
    const slot = `${WEEKDAYS[weekday] ?? "?"} ${hourLabel(hour)}–${hourLabel((hour + 1) % 24)}`;
    return cell ? `${slot}: ${compact(cell.tokens)} tokens across ${full(cell.requests)} ${cell.requests === 1 ? "request" : "requests"}` : `${slot}: dead quiet. Everyone behaving.`;
  };
  const shown = picked ?? peakKey;
  const hoursRow = Array.from({ length: 24 }, (_, h) => h);
  return (
    <section className="heat panel" aria-labelledby="heat-title">
      <SectionHead id="heat-title" title="Hours of" mark="weakness" note={`Tokens by weekday and hour over the last 28 days, regardless of range. ${board.timezone} time.`} />
      <div className="heat-grid" role="img" aria-label={peakKey !== null ? `Heatmap of tokens by weekday and hour. Busiest slot, ${describe(peakKey)}.` : "Heatmap of tokens by weekday and hour. No traffic in the last 28 days."} onPointerLeave={() => setPicked(null)}>
        <span className="heat-band band-night" aria-hidden="true">
          bad decisions
        </span>
        <span className="heat-band band-office" aria-hidden="true">
          "working hours"
        </span>
        {hoursRow.map((h) =>
          h % 3 === 0 ? (
            <span key={h} className="heat-hour" style={{ gridColumn: h + 2 }} aria-hidden="true">
              {String(h).padStart(2, "0")}
            </span>
          ) : null,
        )}
        {WEEKDAYS.map((name, weekday) => [
          <span key={name} className={`heat-day ${weekday >= 5 ? "is-weekend" : ""}`} style={{ gridRow: weekday + 3 }} aria-hidden="true">
            {name}
          </span>,
          ...hoursRow.map((hour) => {
            const key = weekday * 24 + hour;
            const cell = cells.get(key);
            // A gentle curve so one monster hour does not flatten the rest of the week.
            const level = cell && max > 0 ? Math.pow(cell.tokens / max, 0.7) : 0;
            return (
              <i
                key={key}
                className={`heat-cell ${cell ? "" : "is-empty"} ${key === shown ? "is-picked" : ""}`}
                style={{ gridRow: weekday + 3, gridColumn: hour + 2, background: cell ? heatColour(0.06 + level * 0.94) : undefined }}
                title={describe(key)}
                onPointerEnter={() => setPicked(key)}
                onPointerDown={() => setPicked(key)}
              />
            );
          }),
        ])}
      </div>
      <div className="heat-foot">
        <p className="heat-readout" aria-live="off">
          <b>{picked !== null ? "Slot" : "Peak"}</b> {shown !== null ? describe(shown) : "Zero traffic in the last 28 days. Incredible restraint."}
        </p>
        <p className="heat-scale" aria-hidden="true">
          calm
          {[0.06, 0.3, 0.55, 0.8, 1].map((l) => (
            <i key={l} style={{ background: heatColour(l) }} />
          ))}
          feral
        </p>
      </div>
    </section>
  );
}
