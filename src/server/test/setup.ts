// Preloaded by `bun test` (bunfig.toml). Removes the test Postgres container
// when the run is over, however it ends.

import { afterAll } from "bun:test";
import { removeTestContainer } from "./pg.ts";

afterAll(async () => {
  await removeTestContainer();
}, 60_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void removeTestContainer().finally(() => process.exit(130));
  });
}
