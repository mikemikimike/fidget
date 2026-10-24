// poke-mid-climb and question-bubble skip only when a fullscreen window would
// take the click. The pure decision is loaded through the parser, including a
// helper the leaf dot-sources, so no window or app launch runs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { test } from "node:test";

import { resolvePwsh } from "./pwsh-resolve.js";

const leaves = ["poke-mid-climb.win.ps1", "question-bubble.win.ps1"].map((name) =>
  join(import.meta.dirname, "..", "scripts", "scenarios", "ci", name),
);
const resolved = resolvePwsh();
const skip = resolved.kind === "ready" ? false : resolved.reason;

function decisionFiles(leaf) {
  const files = [leaf];
  const text = readFileSync(leaf, "utf8");
  for (const match of text.matchAll(/['"]([^'"]+\.ps1)['"]/g)) {
    const full = normalize(join(dirname(leaf), match[1].replaceAll("\\", "/")));
    if (existsSync(full) && !files.includes(full)) files.push(full);
  }
  return files;
}

function run(leaf, body) {
  const loader = `
$ErrorActionPreference = 'Stop'
$loaded = $false
foreach ($file in ($env:LEAF_FILES -split '\\|')) {
  if (-not (Test-Path -LiteralPath $file)) { continue }
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { throw "parse errors in $($file): $($errors | Out-String)" }
  foreach ($fn in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Get-FullscreenOverClick' }, $true)) {
    Invoke-Expression $fn.Extent.Text
    $loaded = $true
  }
}
if (-not $loaded) { throw "Get-FullscreenOverClick is not the skip decision. A frontmost fullscreen window still skips the leaf." }
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
${body}`;
  const out = spawnSync(
    resolved.command,
    [...(resolved.args ?? []), "-NoProfile", "-NonInteractive", "-Command", loader],
    {
      env: { ...process.env, LEAF_FILES: decisionFiles(leaf).join("|"), TERM: "dumb" },
      encoding: "utf8",
    },
  );
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim().split(/\r?\n/);
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
