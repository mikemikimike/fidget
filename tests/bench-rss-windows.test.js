// scripts/bench-rss-windows.ps1 waits for the overlay line before sampling.
// A fake app (a bash script, so these run where pwsh runs on Linux) writes
// that line where a release or a debug build would.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { resolvePwsh } from "./pwsh-resolve.js";
import { tempDir } from "./temp-path.js";

const script = join(import.meta.dirname, "..", "scripts", "bench-rss-windows.ps1");
const resolved = resolvePwsh();
const skip =
  process.platform === "win32"
    ? "the fake app is a bash script"
    : resolved.kind === "ready"
      ? false
      : resolved.reason;

// Runs the bench against a fake app whose body is `app`. FIDGET_DATA_DIR is
// the data folder, as it is for the app.
function bench(t, app, seed = "") {
  const dir = tempDir(t, "bench-rss-windows-");
  const data = join(dir, "data");
  mkdirSync(data);
  if (seed) writeFileSync(join(data, "process.log"), seed);
  const bin = join(dir, "fakefid");
  writeFileSync(bin, `#!/bin/bash\n${app}\n`);
  chmodSync(bin, 0o755);
  const result = spawnSync(
    resolved.command,
    [
      ...(resolved.args ?? []),
      "-NoProfile",
      "-NonInteractive",
      "-File",
      script,
      "-Bin",
      bin,
      "-Settle",
      "0",
      "-Seconds",
      "1",
      "-Interval",
      "1",
      "-Out",
      join(dir, "rss.tsv"),
    ],
    {
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, FIDGET_DATA_DIR: data, TERM: "dumb" },
    },
  );
  return { ...result, data };
}

test(
  "a release build's overlay line, only in process.log, starts sampling",
  { skip },
  (t) => {
    const run = bench(
      t,
      'sleep 1; printf "%s overlay: 2 displays\\n" "$(date +%s)" >> "$FIDGET_DATA_DIR/process.log"; sleep 30',
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /displays: 2 /);
    assert.match(run.stdout, /total {3}samples: [1-9]/);
  },
);

test(
  "a debug build's overlay line on stderr starts sampling when process.log has none",
  { skip },
  (t) => {
    const run = bench(t, 'sleep 1; echo "overlay: 3 displays" >&2; sleep 30');
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /displays: 3 /);
    assert.match(run.stdout, /total {3}samples: [1-9]/);
  },
);

test(
  "an overlay line left in process.log by an earlier run does not count",
  { skip },
  (t) => {
    // Alive long enough for a stale line to be read, then gone, so only a
    // bench that took the stale line samples.
    const run = bench(t, "sleep 5", "1000000000 overlay: 1 display\n");
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.doesNotMatch(run.stdout, /samples:/);
  },
);
