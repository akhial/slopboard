// Standalone dev server for the UI: serves index.html through Bun's HTML import (the same way
// the real backend does) and answers /api/board from the mock generator.
//
//   bun --hot src/web/dev-server.ts            then open http://localhost:4173
//   PORT=5000 bun src/web/dev-server.ts
//
// Opening the page without ?mock=1 exercises the real fetch path against this mock API.
// Add ?scenario=empty|never|quiet|stale|flaky|error to the page address to make the API
// misbehave (the server reads it from the Referer header, so the client code stays unaware),
// or set SLOP_SCENARIO to force one for every request.

import { BOARD_PATH } from "../shared/api.ts";
import type { ApiError, RangeKey } from "../shared/api.ts";
import index from "./index.html";
import { MOCK_ERROR, mockBoard, parseScenario } from "./mock.ts";
import type { Scenario } from "./mock.ts";

const RANGE_KEYS: readonly RangeKey[] = ["today", "7d", "30d", "all"];
const port = Number(process.env.PORT ?? 4173);
let flakyHits = 0;

function scenarioFor(req: Request): Scenario {
  if (process.env.SLOP_SCENARIO) return parseScenario(process.env.SLOP_SCENARIO);
  const direct = new URL(req.url).searchParams.get("scenario");
  if (direct) return parseScenario(direct);
  const referer = req.headers.get("referer");
  if (!referer) return "normal";
  try {
    return parseScenario(new URL(referer).searchParams.get("scenario"));
  } catch {
    return "normal";
  }
}

function fail(status: number, error: string): Response {
  const body: ApiError = { error };
  return Response.json(body, { status });
}

const server = Bun.serve({
  port,
  development: true,
  routes: {
    "/": index,
    [BOARD_PATH]: (req: Request) => {
      const requested = new URL(req.url).searchParams.get("range") ?? "7d";
      const range = RANGE_KEYS.find((r) => r === requested);
      if (!range) return fail(400, `unknown range "${requested}"`);
      const scenario = scenarioFor(req);
      if (scenario !== "flaky") flakyHits = 0;
      if (scenario === "error" || (scenario === "flaky" && flakyHits++ > 0)) return fail(503, MOCK_ERROR);
      return Response.json(mockBoard(range, scenario), { headers: { "cache-control": "no-store" } });
    },
  },
  fetch() {
    return fail(404, "not found");
  },
});

console.log(`slopboard UI dev server: ${server.url}  (demo mode: ${server.url}?mock=1)`);
