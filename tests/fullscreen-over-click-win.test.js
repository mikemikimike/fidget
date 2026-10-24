// poke-mid-climb and question-bubble skip only when a fullscreen window would
// take the click. The pure decision is loaded through the parser, including a
// helper the leaf dot-sources, so no window or app launch runs.

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { runFullscreenOverClick } from "./fullscreen-over-click-win.js";
import { resolvePwsh } from "./pwsh-resolve.js";

const leaves = ["poke-mid-climb.win.ps1", "question-bubble.win.ps1"].map((name) =>
  join(import.meta.dirname, "..", "scripts", "scenarios", "ci", name),
);
const resolved = resolvePwsh();
const skip = resolved.kind === "ready" ? false : resolved.reason;

function run(leaf, body) {
  return runFullscreenOverClick(
    resolved,
    leaf,
    `
$screens = @(@{ Left = 0; Top = 0; Width = 1920; Height = 1080 }, @{ Left = 1920; Top = 0; Width = 2560; Height = 1440 }, @{ Left = 0; Top = 1080; Width = 1920; Height = 1080 })
function Win($procId, $title, $left, $top, $right, $bottom, $exStyle = 0, $cloaked = $false) {
  @{ Pid = $procId; Class = $title; Title = $title; Left = $left; Top = $top; Right = $right; Bottom = $bottom; ExStyle = $exStyle; Cloaked = $cloaked }
}
$fidget = Win 7 'overlay' 0 0 4480 2160 0xA0
$game = Win 9 'Game' 0 0 1920 1080
$video = Win 11 'Video' 1920 0 4480 1440
function Over($windows) {
  $hit = Get-FullscreenOverClick $windows $screens 960 540 7
  if ($hit) { $hit.Title } else { 'none' }
}
${body}`,
  );
}

for (const leaf of leaves) {
  const name = leaf.split("/").pop();

  test(
    `${name}: a fullscreen window stacked over Fidget at the click point takes the click`,
    { skip },
    () => {
      assert.deepEqual(run(leaf, "Over @($game, $fidget)"), ["Game"]);
    },
  );

  test(
    `${name}: a fullscreen window under Fidget's topmost overlay leaves the click to Fidget`,
    { skip },
    () => {
      assert.deepEqual(run(leaf, "Over @($fidget, $game)"), ["none"]);
    },
  );

  test(
    `${name}: a fullscreen window on another display than the click does not matter`,
    { skip },
    () => {
      assert.deepEqual(run(leaf, "Over @($video, $fidget)"), ["none"]);
    },
  );
}
