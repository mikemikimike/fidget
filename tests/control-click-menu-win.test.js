// scripts/scenarios/control-click-menu.win.ps1 skips only when a fullscreen
// window would take its right-click. Only the pure decision is loaded, through
// the PowerShell parser, so no window or app launch runs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

import { resolvePwsh } from "./pwsh-resolve.js";

const script = join(
  import.meta.dirname,
  "..",
  "scripts",
  "scenarios",
  "control-click-menu.win.ps1",
);
const resolved = resolvePwsh();
const skip = resolved.kind === "ready" ? false : resolved.reason;

function run(body) {
  const loader = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:MENU_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "parse errors: $($errors | Out-String)" }
foreach ($fn in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq "Get-FullscreenOverClick" }, $true)) {
  Invoke-Expression $fn.Extent.Text
}
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
${body}`;
  const out = spawnSync(
    resolved.command,
    [
      ...(resolved.args ?? []),
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      loader,
    ],
    {
      env: { ...process.env, MENU_SCRIPT: script, TERM: "dumb" },
      encoding: "utf8",
    },
  );
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim().split(/\r?\n/);
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
