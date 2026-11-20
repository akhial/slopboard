// One colour per person, the same in every chart.
//
// The colour is derived from the person's id: a hash picks a slot in a palette of flat, loud
// accents (the board's lime and purple plus pink, orange, blue, teal and yellow) that stay
// distinct next to each other and keep dark text readable, in light and dark mode alike. With a
// handful of people two ids often hash to the same slot, so a clash moves the later id
// (alphabetically) to the next free slot, and the outcome is remembered in localStorage so
// nobody changes colour when the set of people differs between ranges.

const PALETTE = [
  "#d8ff54", // lime
  "#c575f8", // purple
  "#ff5db1", // pink
  "#ff9f43", // orange
  "#7cc4ff", // blue
  "#3ee0b5", // teal
  "#ffe45c", // yellow
] as const;

/** The unassigned "shared" bucket is never a palette colour. */
export const GHOST = "#9a9a9a";

const STORE_KEY = "slopboard.colours.v1";

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function load(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && v >= 0 && v < 1000) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return {};
  }
}

const slots: Record<string, number> = load();
const ghosts = new Set<string>();

/** Call with every board so new people get a slot before anything renders. */
export function registerPeople(people: readonly { id: string; unassigned: boolean }[]): void {
  const fresh: string[] = [];
  for (const p of people) {
    if (p.unassigned) ghosts.add(p.id);
    else {
      ghosts.delete(p.id);
      if (!(p.id in slots)) fresh.push(p.id);
    }
  }
  if (fresh.length === 0) return;
  fresh.sort();
  const used = new Set(Object.values(slots));
  for (const id of fresh) {
    let slot = hash(id) % PALETTE.length;
    if (PALETTE.every((_, i) => used.has(i))) {
      // More people than hand-picked colours: carry on with generated ones.
      slot = PALETTE.length;
      while (used.has(slot)) slot++;
    } else {
      while (used.has(slot)) slot = (slot + 1) % PALETTE.length;
    }
    slots[id] = slot;
    used.add(slot);
  }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(slots));
  } catch {
    // Private mode: colours still hold for this page view.
  }
}

/** Colours past the palette: hues a golden angle apart, kept light enough for dark text. */
function generated(n: number): string {
  const hue = Math.round((n * 137.508 + 20) % 360);
  return `hsl(${hue} ${n % 2 ? 85 : 95}% ${n % 3 ? 66 : 72}%)`;
}

/** Ids that are not a registered person (the shared key, anything unknown) stay grey. */
export function colourOf(id: string | null | undefined): string {
  if (!id || ghosts.has(id)) return GHOST;
  const slot = slots[id];
  if (slot === undefined) return GHOST;
  return PALETTE[slot] ?? generated(slot - PALETTE.length);
}

/**
 * Hands each id one option from the list: the same id starts at the same option every time, and
 * ids that would land on a taken one move along, so a short list of people gets no repeats.
 */
export function dealOut<T>(ids: readonly string[], options: readonly T[]): Map<string, T> {
  const dealt = new Map<string, T>();
  const taken = new Set<number>();
  for (const id of ids) {
    if (options.length === 0) break;
    let at = hash(id) % options.length;
    for (let tries = 0; taken.has(at) && tries < options.length; tries++) at = (at + 1) % options.length;
    taken.add(at);
    if (taken.size === options.length) taken.clear();
    const option = options[at];
    if (option !== undefined) dealt.set(id, option);
  }
  return dealt;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? "?";
  const second = words[1];
  if (second) return ((first[0] ?? "") + (second[0] ?? "")).toUpperCase();
  return first.slice(0, 2).toUpperCase();
}
