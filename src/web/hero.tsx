// Headline numbers for the whole team: the big total and what it is made of, the black slab of
// team numbers, and the donut of who is to blame.

import type { ReactNode } from "react";
import type { Board, RangeKey } from "../shared/api.ts";
import { Burst, Cutout, Doodle, Icon, IconDisc, Ticket, TornNote } from "./art.tsx";
import type { CutoutName, IconName } from "./art.tsx";
import { colourOf, initials } from "./colors.ts";
import { rangeInfo } from "./data.ts";
import { compact, full, pct, usd } from "./format.ts";
import { taglineFor } from "./masthead.tsx";
import { Num, TOKEN_KINDS, personStyle } from "./ui.tsx";

function mood(tokensPerMinute: number): string {
  if (tokensPerMinute <= 0) return "Dead silence. Somebody might actually be typing.";
  if (tokensPerMinute < 20_000) return "Light poking. Barely warming the GPUs.";
  if (tokensPerMinute < 150_000) return "Cruising altitude. Nobody's reading the diffs.";
  if (tokensPerMinute < 600_000) return "Full industrial slop production.";
  return "Datacenter cooling fans audible from here.";
}

/** How many bars of the five-bar gauge to light, on a log scale from 1K to 10M tokens a minute. */
function gaugeLevel(tokensPerMinute: number): number {
  if (tokensPerMinute <= 0) return 0;
  return Math.max(1, Math.min(5, Math.ceil(Math.log10(tokensPerMinute) - 2)));
}

/** The question the slab asks, with the range as its scribbled ending. */
const WHEN: Record<RangeKey, string> = { today: "today?", "7d": "this week?", "30d": "this month?", all: "so far?" };

/** The complete works run to roughly 885,000 words, at about 1.3 tokens a word. */
const SHAKESPEARE = 1_180_000;

const KIND_ICONS: Record<(typeof TOKEN_KINDS)[number]["key"], IconName> = { input: "down", cacheRead: "recycle", cacheWrite: "pencil", output: "up" };

/** The big number and what it is made of. */
export function HeroMain({ board }: { board: Board }) {
  const t = board.totals;
  const info = rangeInfo(board.range);
  const shakespeares = Math.round(t.tokens.total / SHAKESPEARE);
  const cachedMostly = t.tokens.total > 0 && t.tokens.cacheRead / t.tokens.total >= 0.5;
  const sum = t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite + t.tokens.output;
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="balance">
        <div className="balance-main">
          <h2 className="balance-label" id="hero-title">
            Compute incinerated {info.phrase}
            <Icon name="eye" />
          </h2>
          <p className="balance-number">
            <Num value={t.tokens.total} />
            <span className="balance-unit">tokens</span>
          </p>
          {t.tokens.total >= SHAKESPEARE ? (
            <p className="balance-sub">
              {shakespeares <= 1 ? (
                <>Roughly the complete works of Shakespeare, once over</>
              ) : (
                <>
                  The complete works of Shakespeare, <b>{full(shakespeares)}</b> times over
                </>
              )}
              {cachedMostly ? ", mostly re-reading the same file from cache like it might have changed." : ", and not a single sonnet to show for it."}
            </p>
          ) : null}
        </div>
        <TornNote className="balance-note">
          {taglineFor(board)}
          <Doodle name="ticks" />
        </TornNote>
      </div>
      <ul className="kinds">
        {TOKEN_KINDS.map((k) => {
          const share = sum > 0 ? t.tokens[k.key] / sum : 0;
          return (
            <li key={k.key} className={`kind kind-${k.key}`} title={`${k.hint}: ${full(t.tokens[k.key])}`}>
              <Icon name={KIND_ICONS[k.key]} />
              <span className="kind-label">{k.label}</span>
              <b>
                <Num value={t.tokens[k.key]} />
              </b>
              <small>{sum > 0 ? pct(share) : "–"}</small>
              <i className="kind-bar" aria-hidden="true">
                <i className={`seg-${k.key}`} style={{ width: `${Math.max(share > 0 ? 3 : 0, share * 100)}%` }} />
              </i>
            </li>
          );
        })}
      </ul>
      {t.tokens.reasoning > 0 ? (
        <p className="hero-foot">
          {compact(t.tokens.reasoning)} of the output ({pct(t.tokens.output > 0 ? t.tokens.reasoning / t.tokens.output : 0)}) was the models arguing with themselves before answering.
        </p>
      ) : null}
    </section>
  );
}

interface TileSpec {
  key: string;
  icon: IconName;
  title: string;
  fill: "lime" | "white" | "purple";
  number: ReactNode;
  note: ReactNode;
  art: ReactNode;
  extra?: ReactNode;
}

function art(name: CutoutName, decor: ReactNode = null) {
  return (
    <div className="tile-art" aria-hidden="true">
      {decor}
      <Cutout name={name} />
    </div>
  );
}

/** The team's numbers, as a stack of loud cards on a black slab. */
export function Tiles({ board }: { board: Board }) {
  const t = board.totals;
  // The server counts the people who actually sent something. A key alone is not a mouth.
  const mouths = t.people;
  const sharedActive = board.people.some((p) => p.unassigned && p.requests > 0);
  const benched = board.people.filter((p) => !p.unassigned && p.requests === 0).length;
  const unpriced = board.models.filter((m) => !m.priced);
  const failedShare = t.requests > 0 ? t.failedRequests / t.requests : 0;
  const level = gaugeLevel(t.tokensPerMinuteNow);
  // Null means tokens without any list price. With no tokens at all it is a plain zero.
  const cost = t.costUsd === null && t.tokens.total === 0 ? 0 : t.costUsd;
  const tiles: TileSpec[] = [
    {
      key: "burn",
      icon: "flame",
      title: "Burn rate",
      fill: "lime",
      number: (
        <>
          <Num value={t.tokensPerMinuteNow} />
          <span className="tile-unit">tokens / min</span>
        </>
      ),
      note: mood(t.tokensPerMinuteNow),
      art: art("match", <Doodle name="ticks" className="d-ink" />),
      extra: (
        <span className={`gauge level-${level}`} aria-hidden="true">
          {[1, 2, 3, 4, 5].map((n) => (
            <i key={n} className={n <= level ? "on" : ""} />
          ))}
        </span>
      ),
    },
    {
      key: "invoice",
      icon: "receipt",
      title: "Fake invoice",
      fill: "white",
      number: cost === null ? <span className="unpriced">unpriced</span> : <Num value={cost} format={usd} />,
      note: (
        <>
          {cost === null ? "No public list price known for these models." : "List price. Flat-rate plans mean $0 billed."}
          {t.costUsd !== null && unpriced.length > 0 ? <span title={`No public list price known for: ${unpriced.map((m) => m.displayName).join(", ")}`}> {unpriced.length} {unpriced.length === 1 ? "model" : "models"} unpriced.</span> : null}
        </>
      ),
      art: art(
        "receipt",
        <span className="scribble-note">
          not a bill
          <Doodle name="oval" />
        </span>,
      ),
    },
    {
      key: "requests",
      icon: "megaphone",
      title: "Requests",
      fill: "purple",
      number: <Num value={t.requests} />,
      note: t.failedRequests > 0 ? `${full(t.failedRequests)} went down in flames (${pct(failedShare)}).` : t.requests > 0 ? "Zero failures. Suspiciously competent." : "Not a single prompt sent.",
      art: art("megaphone", <Doodle name="ticks" className="d-lime" />),
    },
    {
      key: "threads",
      icon: "thread",
      title: "Threads",
      fill: "white",
      number: <Num value={t.threads} />,
      note: t.threads === 0 ? "Not even a warm-up chat." : t.threads === 1 ? "One thread. Still time to quit." : 'Half of them started with "quick question".',
      art: art("spool", <Doodle name="loop" className="d-lime" />),
    },
    {
      key: "subagents",
      icon: "robot",
      title: "Subagents",
      fill: "lime",
      number: <Num value={t.subagents} />,
      note: t.subagents === 0 ? "Zero interns spawned. DIY era." : t.threads > 0 ? `${(t.subagents / t.threads).toFixed(1)} unpaid interns per thread.` : "Unpaid interns deployed.",
      art: art("robot", <Burst className="d-purple" />),
    },
    {
      key: "people",
      icon: "people",
      title: "Caught prompting",
      fill: "purple",
      number: (
        <>
          <Num value={mouths} format={full} />
          <span className="tile-unit">{mouths === 1 ? "person" : "people"}</span>
        </>
      ),
      note: sharedActive
        ? mouths === 0
          ? "Only the mystery shared key. Nobody's confessing."
          : "Plus the mystery shared key nobody claims."
        : mouths === 0
          ? "All hands suspiciously on keyboards."
          : benched > 0
            ? `${benched} more ${benched === 1 ? "has a key and is" : "have keys and are"} pretending to be above this.`
            : "Full roster. Nobody escaped.",
      art: art(
        "handcuffs",
        <Ticket className="tile-ticket">
          Guilty
          <br />
          as
          <br />
          charged
          <Doodle name="smiley" />
        </Ticket>,
      ),
    },
  ];
  return (
    <section className="slab tiles" aria-labelledby="tiles-title">
      <h2 className="slab-title" id="tiles-title">
        What did we
        <br />
        burn <em className="scrawl">{WHEN[board.range]}</em>
      </h2>
      <ul className="tile-list">
        {tiles.map((tile) => (
          <li key={tile.key} className={`tile wonk fill-${tile.fill} tile-${tile.key}`}>
            <IconDisc name={tile.icon} />
            <div className="tile-text">
              <h3>{tile.title}</h3>
              <p className="tile-number">{tile.number}</p>
              <p className="tile-note">{tile.note}</p>
            </div>
            {tile.art}
            {tile.extra}
          </li>
        ))}
      </ul>
      <p className="slab-foot" aria-hidden="true">
        <Cutout name="coin-stack" />
        Keep scrolling for the receipts
        <Doodle name="arrow" />
      </p>
    </section>
  );
}

/** Who is to blame: the donut, with everyone's share listed underneath. */
export function Guilt({ board }: { board: Board }) {
  const sum = board.people.reduce((s, p) => s + p.tokens.total, 0);
  const shares = board.people.filter((p) => p.tokens.total > 0).map((p) => ({ p, share: sum > 0 ? p.tokens.total / sum : 0 }));
  const r = 40;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const suspects = shares.filter((s) => !s.p.unassigned).length;
  return (
    <section className="slab guilt" aria-labelledby="guilt-title">
      <h2 className="guilt-title" id="guilt-title">
        Distribution of <em className="scrawl">guilt</em>
      </h2>
      <div className="donut" role="img" aria-label={`Share of tokens: ${shares.map((s) => `${s.p.name} ${pct(s.share)}`).join(", ")}`}>
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r={r} className="donut-track" />
          {shares.map(({ p, share }) => {
            const length = share * circumference;
            const seg = (
              <circle
                key={p.id}
                cx="50"
                cy="50"
                r={r}
                className={p.unassigned ? "donut-seg is-ghost" : "donut-seg"}
                stroke={colourOf(p.id)}
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
              />
            );
            offset += length;
            return seg;
          })}
        </svg>
        <div className="donut-centre">
          <span>Total</span>
          <b>
            <Num value={sum} />
          </b>
          <small>
            {suspects} {suspects === 1 ? "suspect" : "suspects"}
          </small>
        </div>
      </div>
      <ul className="guilt-list">
        {shares.map(({ p, share }) => (
          <li key={p.id} style={personStyle(p.id)} className={p.unassigned ? "is-ghost" : ""}>
            <span className="guilt-disc" aria-hidden="true">
              {p.unassigned ? "?" : initials(p.name)}
            </span>
            <span className="guilt-name">{p.name}</span>
            <b>{compact(p.tokens.total)}</b>
            <small>{pct(share)}</small>
            <Icon name="chevron" />
          </li>
        ))}
      </ul>
    </section>
  );
}
