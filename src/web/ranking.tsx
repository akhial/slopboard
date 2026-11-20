// The leaderboard: a podium for the top three, the full standings below it, and a bench for
// everyone who has a key but has not used it in this range.

import type { ReactNode } from "react";
import type { Board, PersonRow } from "../shared/api.ts";
import { dealOut } from "./colors.ts";
import { rangeInfo } from "./data.ts";
import { clockFor, compact, full, hourLabel, pct, usd } from "./format.ts";
import { Cutout, Doodle, StickyNote } from "./art.tsx";
import { Avatar, contenders, Move, movementOf, Num, personStyle, SectionHead, Spark, SplitBar, TOKEN_KINDS } from "./ui.tsx";

const PODIUM_TITLES = ["Lead defendant", "Willing accomplice", "Accessory to slop"];

/** The chip on a bank card, drawn. */
function Chip() {
  return (
    <svg className="card-chip" viewBox="0 0 48 38" aria-hidden="true">
      <rect x="1.5" y="1.5" width="45" height="35" rx="7" />
      <path d="M1.5 13h13M1.5 25h13M33.5 13h13M33.5 25h13M14.5 1.5v35M33.5 1.5v35M14.5 19h19" />
    </svg>
  );
}

/** Null means "tokens, but no list price for any of them". No tokens at all is a plain $0. */
function Cost({ person }: { person: PersonRow }) {
  if (person.costUsd === null && person.tokens.total > 0) {
    return (
      <span className="unpriced" title="No public API list price known for these models — not the same as free.">
        unpriced
      </span>
    );
  }
  return <Num value={person.costUsd ?? 0} format={usd} />;
}

/** The leader, as a loud bank card on a scrap of torn paper. */
function LeaderCard({ person, board }: { person: PersonRow; board: Board }) {
  const info = rangeInfo(board.range);
  return (
    <article className="leader-card" aria-label={`Place 1: ${person.name}`}>
      <StickyNote className="leader-note">
        {PODIUM_TITLES[0]}
        <Doodle name="crown" />
      </StickyNote>
      <Cutout name="melting-smiley" className="leader-smiley" />
      <Doodle name="ticks" className="leader-ticks" />
      <Chip />
      <h3 className="leader-name">{person.name}</h3>
      <p className="leader-meta">
        <span>
          <Num value={person.tokens.total} /> tokens
        </span>
        <span>
          <Cost person={person} /> fake bill · {compact(person.subagents)} interns · {person.streakDays}d streak
        </span>
      </p>
      <p className="leader-rank">
        <span aria-hidden="true">#1</span>
        <Move movement={movementOf(person, board.range)} previous={info.previous} />
      </p>
    </article>
  );
}

function RunnerCard({ person, place, board }: { person: PersonRow; place: number; board: Board }) {
  const info = rangeInfo(board.range);
  return (
    <li className={`runner wonk ${place === 2 ? "fill-purple" : "fill-white"}`} style={personStyle(person.id)} aria-label={`Place ${place}: ${person.name}`}>
      <span className="runner-rank" aria-hidden="true">
        {place}
      </span>
      <div className="runner-who">
        <h3>{person.name}</h3>
        <p>{PODIUM_TITLES[place - 1]}</p>
      </div>
      <p className="runner-tokens">
        <b>
          <Num value={person.tokens.total} />
        </b>
        <span>tokens</span>
      </p>
      <Move movement={movementOf(person, board.range)} previous={info.previous} />
    </li>
  );
}

const VACANT_LINES = ["Alibi holds (for now)", "Open for indictment", "Low bar, still empty"];

export function Podium({ board }: { board: Board }) {
  // Only people with tokens in this range get a place. A key and a zero do not make a champion.
  const top = contenders(board).slice(0, 3);
  const [first, ...rest] = top;
  const info = rangeInfo(board.range);
  return (
    <section className="podium" aria-labelledby="podium-title">
      <h2 className="sr-only" id="podium-title">
        The podium: most tokens {info.phrase}
      </h2>
      <div className="leader">
        {first ? (
          <LeaderCard person={first} board={board} />
        ) : (
          <article className="leader-card is-vacant">
            <StickyNote className="leader-note">{VACANT_LINES[0]}</StickyNote>
            <Chip />
            <h3 className="leader-name">Vacant</h3>
            <p className="leader-meta">
              <span>Nobody with a name has burned a token {info.phrase}.</span>
            </p>
          </article>
        )}
      </div>
      <ol className="runners" start={2}>
        {[2, 3].map((place) => {
          const person = rest[place - 2];
          return person ? (
            <RunnerCard key={person.id} person={person} place={place} board={board} />
          ) : (
            <li key={place} className="runner is-vacant">
              <span className="runner-rank" aria-hidden="true">
                {place}
              </span>
              <div className="runner-who">
                <h3>Vacant</h3>
                <p>{VACANT_LINES[place - 1]}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** One line of the standings. `place` is null for rows that are shown but not ranked. */
function Row({ person, place, board }: { person: PersonRow; place: number | null; board: Board }) {
  const info = rangeInfo(board.range);
  const clock = clockFor(board.timezone);
  const ghost = person.unassigned;
  // Seen today: the time says it all. Otherwise say which day.
  const seenToday = person.lastSeenAt !== null && clock.date(person.lastSeenAt) === clock.date(board.generatedAt);
  const seen = person.lastSeenAt ? `seen ${seenToday ? clock.time(person.lastSeenAt) : clock.dayTime(person.lastSeenAt)}` : null;
  const habits = [person.peakHour !== null ? `peaks ${hourLabel(person.peakHour)}` : null, seen].filter(Boolean).join(" · ");
  return (
    <li className={`row ${ghost ? "is-ghost" : ""} ${place !== null && place <= 3 ? `is-top place-${place}` : ""}`} style={personStyle(person.id)}>
      <div className="c-rank">
        <span className="rank-num">
          <span className="sr-only">{place === null ? "Not ranked" : "Place "}</span>
          {place ?? "–"}
        </span>
        <Move movement={movementOf(person, board.range)} previous={info.previous} />
      </div>
      <div className="c-who">
        <Avatar id={person.id} name={person.name} ghost={ghost} />
        <div className="who-text">
          <h3>
            {person.name}
            {ghost ? (
              <span className="tag tag-ghost" title="Traffic on keys that belong to nobody — the old shared key or unknown keys. Shown on the sheet, ineligible for medals.">
                unclaimed
              </span>
            ) : place === null ? (
              <span className="tag tag-bad" title="Sent requests, got zero tokens back. Pure tragedy.">
                0 tokens
              </span>
            ) : null}
          </h3>
          <p className="who-meta" title={person.topModel ? `Most tokens went to ${person.topModel}` : undefined}>
            {ghost ? "Unindicted co-conspirator." : (person.topModel ?? "no favourite yet")}
          </p>
          <p className="who-meta" title={person.lastSeenAt ? `Last request ${clock.stamp(person.lastSeenAt)}` : undefined}>
            {ghost ? (person.topModel ?? habits) : habits}
          </p>
        </div>
      </div>
      <div className="c-tokens">
        <span className="label">Tokens</span>
        <b className="big">
          <Num value={person.tokens.total} />
        </b>
        <SplitBar tokens={person.tokens} />
        <p className="split-nums">
          {TOKEN_KINDS.map((k) => (
            <span key={k.key} title={`${k.hint}: ${full(person.tokens[k.key])}`}>
              <i className={`swatch seg-${k.key}`} aria-hidden="true" />
              <span className="sr-only">{k.label} </span>
              {compact(person.tokens[k.key])}
            </span>
          ))}
        </p>
      </div>
      <div className="c-stat c-cost">
        <span className="label">Fake bill</span>
        <b>
          <Cost person={person} />
        </b>
      </div>
      <div className="c-stat">
        <span className="label">Threads</span>
        <b>
          <Num value={person.threads} />
        </b>
        <small>{compact(person.requests)} {person.requests === 1 ? "request" : "requests"}</small>
        {person.failedRequests > 0 ? <small className="bad">{compact(person.failedRequests)} failed</small> : null}
      </div>
      <div className="c-stat">
        <span className="label">Subagents</span>
        <b>
          <Num value={person.subagents} />
        </b>
        <small>{pct(person.subagentTokenShare)} of total</small>
      </div>
      <div className="c-stat">
        <span className="label">Cache hits</span>
        <b>{pct(person.cacheHitRate)}</b>
        <span className="meter" aria-hidden="true">
          <i style={{ width: `${Math.max(0, Math.min(1, person.cacheHitRate)) * 100}%` }} />
        </span>
      </div>
      <div className="c-stat">
        <span className="label">Streak</span>
        <b>
          {person.streakDays}
          <span className="unit">d</span>
        </b>
        <small title={`Active on ${person.activeDays} ${person.activeDays === 1 ? "day" : "days"} in this range`}>{person.activeDays}d active</small>
      </div>
      <div className="c-trend">
        <span className="label">Trend</span>
        <Spark values={person.spark} id={person.id} />
      </div>
    </li>
  );
}

// What a person with a key and no tokens is presumably up to. Dealt out by id, so it mostly sticks.
const NEVER_SEEN = [
  "Issued a key. Chose to remain a person of mystery.",
  "Still crafting the first prompt in a Google Doc.",
  "Believes in artisanal, hand-typed semicolons.",
  "Has an API key and zero curiosity about where it goes.",
  "Waiting for AI to prove it's not just a fad.",
  "Insists they prefer the feel of a real keyboard.",
  "On the roster purely for moral superiority.",
  "Saving their first prompt for a truly worthy bug.",
  "Probably reading the docs from cover to cover. Unsettling.",
  "Has not yet outsourced a single thought.",
  "Key sitting unopened in the original shrink-wrap.",
  "Holds a valid key. Refuses to be perceived.",
];
const TAKING_A_BREAK = [
  "Writing code with their own two hands like a Victorian.",
  "Suspiciously offline. Might be talking to a human.",
  "Zero tokens. Either on holiday or locked out of SSH.",
  "Taking a brief sabbatical from delegation.",
  "Letting the GPU cluster cool down out of politeness.",
  "Temporarily operating on biological RAM.",
  "Quietly judging the rest of the leaderboard.",
  "No prompts sent. Possibly having a normal life.",
  "Currently debugging via the ancient art of thinking.",
  "Clean for now. The relapse is only a stack trace away.",
  "Using Stack Overflow in private like a fugitive.",
  "Out of frame. Alibi unverified.",
];

/** People who are registered but did nothing in this range. Not ranked, not hidden, gently mocked. */
export function Bench({ board, title, note }: { board: Board; title: string; note: ReactNode }) {
  const idle = board.people.filter((p) => p.requests === 0);
  if (idle.length === 0) return null;
  const clock = clockFor(board.timezone);
  const people = idle.filter((p) => !p.unassigned);
  const quips = new Map([
    ...dealOut(people.filter((p) => !p.lastSeenAt).map((p) => p.id), NEVER_SEEN),
    ...dealOut(people.filter((p) => p.lastSeenAt).map((p) => p.id), TAKING_A_BREAK),
  ]);
  return (
    <div className="bench">
      <header className="bench-head">
        <h3>{title}</h3>
        <p>{note}</p>
      </header>
      <ul className="bench-list">
        {idle.map((p) => (
          <li key={p.id} className={`benched ${p.unassigned ? "is-ghost" : ""}`} style={personStyle(p.id)}>
            <Avatar id={p.id} name={p.name} ghost={p.unassigned} />
            <div className="benched-text">
              <h4>
                {p.name}
                <span className="tag tag-ghost">{p.unassigned ? "unclaimed" : "0 tokens"}</span>
              </h4>
              <p className="benched-quip">{p.unassigned ? "Nobody used the shared key. A rare moment of accountability." : quips.get(p.id)}</p>
              <p className="benched-meta">{p.lastSeenAt ? `Last caught ${clock.date(p.lastSeenAt)} at ${clock.time(p.lastSeenAt)}` : "No priors on file"}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Standings({ board }: { board: Board }) {
  const info = rangeInfo(board.range);
  // Ranked people in server order, then anyone whose requests all failed, then the shared key.
  // Everyone without a single request in the range sits on the bench below.
  const ranked = contenders(board);
  const blanks = board.people.filter((p) => !p.unassigned && p.requests > 0 && p.tokens.total === 0);
  const ghosts = board.people.filter((p) => p.unassigned && p.requests > 0);
  return (
    <section className="standings" aria-labelledby="standings-title">
      <SectionHead
        id="standings-title"
        title="The"
        mark="rap sheet"
        note={
          <>
            Ranked by total tokens.{info.previous ? ` Arrows compare with ${info.previous}.` : null} Bars split tokens into{" "}
            {TOKEN_KINDS.flatMap((k, i) => [
              <span key={k.key} className="legend-item">
                <i className={`swatch seg-${k.key}`} aria-hidden="true" />
                {k.label.toLowerCase()}
              </span>,
              // The separator stays outside the nowrap span so the line can break after it.
              i < TOKEN_KINDS.length - 1 ? ", " : ".",
            ])}
          </>
        }
      />
      <div className="table">
        <div className="row row-head" aria-hidden="true">
          <span>#</span>
          <span>Suspect</span>
          <span>Tokens</span>
          <span title="What these tokens would cost at public API list prices. Nobody is billed this.">Fake bill</span>
          <span>Threads</span>
          <span>Subagents</span>
          <span>Cache hits</span>
          <span>Streak</span>
          <span>Trend</span>
        </div>
        <ol className="rows">
          {ranked.map((p, i) => (
            <Row key={p.id} person={p} place={i + 1} board={board} />
          ))}
          {[...blanks, ...ghosts].map((p) => (
            <Row key={p.id} person={p} place={null} board={board} />
          ))}
        </ol>
      </div>
      <Bench board={board} title="Solid alibis" note={`Holds a key, burned zero tokens ${info.phrase}. Unranked, but watched.`} />
    </section>
  );
}
