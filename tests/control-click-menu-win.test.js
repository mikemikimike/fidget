// scripts/scenarios/ci/control-click-menu.win.ps1 skips only when a fullscreen
// window would take its right-click. Only the pure decision is loaded, through
// the PowerShell parser, so no window or app launch runs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { runFullscreenOverClick } from "./fullscreen-over-click-win.js";
import { resolvePwsh } from "./pwsh-resolve.js";

const script = join(
  import.meta.dirname,
  "..",
  "scripts",
  "scenarios",
  "ci",
  "control-click-menu.win.ps1",
);
const resolved = resolvePwsh();
const skip = resolved.kind === "ready" ? false : resolved.reason;

function waitSettledBody(src) {
  const start = src.indexOf("function Wait-Settled");
  if (start < 0) return "";
  const rest = src.slice(start);
  const end = rest.search(/\n    (function |\$traceFile = )/);
  return end < 0 ? rest.slice(0, 400) : rest.slice(0, end);
}

// A first walk can last past 3 s. A wall-clock Wait-Until 3 gives up while
// the sprite is still moving. Wait-ForRest restarts on each move.
test("Wait-Settled is not a 3 s wall clock from the start of the wait", () => {
  const body = waitSettledBody(readFileSync(script, "utf8"));
  assert.ok(body, "Wait-Settled is missing");
  assert.doesNotMatch(body, /Wait-Until 3/, "Wait-Settled still uses a 3 s wall clock");
  assert.match(body, /Wait-ForRest/, "Wait-Settled must wait on rest, not a fixed budget");
});

function run(body) {
  return runFullscreenOverClick(
    resolved,
    script,
    `
$screens = @(@{ Left = 0; Top = 0; Width = 1920; Height = 1080 }, @{ Left = 1920; Top = 0; Width = 2560; Height = 1440 }, @{ Left = 0; Top = 1080; Width = 1920; Height = 1080 })
function Win($procId, $title, $left, $top, $right, $bottom, $exStyle = 0, $cloaked = $false) {
  @{ Pid = $procId; Class = $title; Title = $title; Left = $left; Top = $top; Right = $right; Bottom = $bottom; ExStyle = $exStyle; Cloaked = $cloaked }
}
# Fidget's overlay is a click-through tool window until the cursor reaches the sprite.
$fidget = Win 7 'overlay' 0 0 4480 2160 0xA0
$game = Win 9 'Game' 0 0 1920 1080
$video = Win 11 'Video' 1920 0 4480 1440
$editor = Win 12 'Editor' 800 400 1200 700
$maximized = Win 13 'Maximized' 0 0 1920 1040
$below = Win 14 'Below' 0 1080 1920 2160
function Over($windows) {
  $hit = Get-FullscreenOverClick $windows $screens 960 540 7
  if ($hit) { $hit.Title } else { 'none' }
}
${body}`,
  );
}

test(
  "a fullscreen window stacked over Fidget at the click point takes the click",
  { skip },
  () => {
    assert.deepEqual(run("Over @($game, $fidget)"), ["Game"]);
  },
);

test(
  "a fullscreen window under Fidget's topmost overlay leaves the click to Fidget",
  { skip },
  () => {
    assert.deepEqual(run("Over @($fidget, $game, $video)"), ["none"]);
  },
);

test(
  "a fullscreen window on another display than the click does not matter",
  { skip },
  () => {
    assert.deepEqual(run("Over @($video, $fidget)"), ["none"]);
  },
);

test(
  "a window over the click that is not fullscreen is not this gate's concern",
  { skip },
  () => {
    assert.deepEqual(run("Over @($editor, $fidget)"), ["none"]);
  },
);

test(
  "a click-through fullscreen window over Fidget passes the click on",
  { skip },
  () => {
    assert.deepEqual(run("Over @((Win 9 'Dimmer' 0 0 1920 1080 0x20), $fidget)"), ["none"]);
  },
);

test(
  "a cloaked fullscreen window over Fidget is not on screen to take the click",
  { skip },
  () => {
    assert.deepEqual(run("Over @((Win 9 'Elsewhere' 0 0 1920 1080 0 $true), $fidget)"), ["none"]);
  },
);

test(
  "a fullscreen tool window over Fidget counts as an overlay, not an app",
  { skip },
  () => {
    assert.deepEqual(run("Over @((Win 9 'Overlay' 0 0 1920 1080 0x80), $fidget)"), ["none"]);
  },
);

test(
  "a maximized window over the click stops short of the screen and is not fullscreen",
  { skip },
  () => {
    assert.deepEqual(run("Over @($maximized, $fidget)"), ["none"]);
  },
);

test(
  "a fullscreen window holding the click's X but not its Y is not at the click",
  { skip },
  () => {
    assert.deepEqual(run("Over @($below, $fidget)"), ["none"]);
  },
);

test(
  "a screen-sized window shifted off the screen's corner is not fullscreen",
  { skip },
  () => {
    assert.deepEqual(
      run(`
Over @((Win 15 'Right' 300 0 2220 1080), $fidget)
Over @((Win 16 'Down' 0 300 1920 1380), $fidget)`),
      ["none", "none"],
    );
  },
);
