// pill-dual-display.win.ps1 checks FIDGET_SCENARIO_TRACE and launches nothing.
// A line that only contains showThinking or hideThinking is not a bubble event.
// An overlay show or hide line is.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { resolvePwsh } from "./pwsh-resolve.js";
import { tempDir } from "./temp-path.js";

const script = join(
  import.meta.dirname,
  "..",
  "scripts",
  "scenarios",
  "manual-only",
  "pill-dual-display.win.ps1",
);

const resolved = resolvePwsh();
const skip = resolved.kind === "ready" ? false : resolved.reason;

const PWSH_HOST_ABORT =
  /FileLoadException|Microsoft\.Management\.Infrastructure|Abort trap|not properly handled/;

const PAINTED = "overlay overlay-0: region rebuild 4 rects (art 2 + hotspots 1 + painted 1)";
const CLEARED = "overlay overlay-0: region rebuild 2 rects (art 1 + hotspots 1 + painted 0)";
const FOLLOW = "overlay overlay-1: pill follows instance=inst-1 chars=4 focused=True";

const REAL = [
  "overlay overlay-0: showSpeech instance=inst-1 dnd=off",
  "12ms overlay overlay-0: hideThinking instance=inst-1 dnd=off",
  PAINTED,
  "overlay overlay-0: hideSpeech instance=inst-1 dnd=off",
  "overlay overlay-0: showThinking instance=inst-1 dnd=off",
  "director: hideThinking still not an overlay line",
  "overlay overlay-0: region rebuild 3 rects (art 1 + hotspots 1 + painted 1)",
  "overlay overlay-0: hideThinking instance=inst-1 dnd=off",
  CLEARED,
  FOLLOW,
];

const DECOY = [
  "12ms overlay overlay-0: showThinking instance=inst-1 dnd=off",
  "director: showThinking still not an overlay line",
  PAINTED,
  "director: hideThinking still not an overlay line",
  CLEARED,
  FOLLOW,
];

function pwshHostAborted(run) {
  return PWSH_HOST_ABORT.test(`${run?.stdout ?? ""}\n${run?.stderr ?? ""}`);
}

function checkTrace(t, lines) {
  const dir = tempDir(t, "pill-dual-");
  const trace = join(dir, "trace.txt");
  writeFileSync(trace, `${lines.join("\n")}\n`);
  const run = spawnSync(
    resolved.command,
    [...(resolved.args ?? []), "-NoProfile", "-NonInteractive", "-File", script, "--go", "fidget"],
    {
      encoding: "utf8",
      env: { ...process.env, FIDGET_SCENARIO_TRACE: trace },
    },
  );
  if (run.status !== 0 && pwshHostAborted(run)) {
    t.skip("pwsh aborted before the bubble check ran");
    return null;
  }
  return run;
}

test("a real overlay show stays visible across a line that only mentions hideThinking", { skip }, (t) => {
  const run = checkTrace(t, REAL);
  if (run == null) return;
  assert.equal(run.status, 0, `trace check failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /PASS: painted rect in region while visible/);
});

test("a line that only contains showThinking or hideThinking is not a bubble event", { skip }, (t) => {
  const run = checkTrace(t, DECOY);
  if (run == null) return;
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(run.stderr, /painted rects not included while bubble visible/);
});
