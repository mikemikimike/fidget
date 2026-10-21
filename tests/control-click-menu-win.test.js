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
$screens = @(@{ Left = 0; Top = 0; Width = 1920; Height = 1080 }, @{ Left = 1920; Top = 0; Width = 2560; Height = 1440 })
$fidget = @{ Pid = 7; Class = 'overlay'; Title = ''; Left = 0; Top = 0; Right = 4480; Bottom = 1440 }
$game = @{ Pid = 9; Class = 'game'; Title = 'Game'; Left = 0; Top = 0; Right = 1920; Bottom = 1080 }
$video = @{ Pid = 11; Class = 'video'; Title = 'Video'; Left = 1920; Top = 0; Right = 4480; Bottom = 1440 }
$editor = @{ Pid = 12; Class = 'editor'; Title = 'Editor'; Left = 800; Top = 400; Right = 1200; Bottom = 700 }
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
