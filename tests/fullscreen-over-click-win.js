import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

// The leaf launches a window. The parser defines Get-FullscreenOverClick from
// the leaf and the .ps1 paths it quotes, and never runs that launch.
const LOADER = `
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
`;

function decisionFiles(leaf) {
  const files = [leaf];
  const text = readFileSync(leaf, "utf8");
  for (const match of text.matchAll(/['"]([^'"]+\.ps1)['"]/g)) {
    const full = normalize(join(dirname(leaf), match[1].replaceAll("\\", "/")));
    if (existsSync(full) && !files.includes(full)) files.push(full);
  }
  return files;
}

export function runFullscreenOverClick(resolved, leaf, body) {
  const out = spawnSync(
    resolved.command,
    [...(resolved.args ?? []), "-NoProfile", "-NonInteractive", "-Command", `${LOADER}${body}`],
    {
      env: { ...process.env, LEAF_FILES: decisionFiles(leaf).join("|"), TERM: "dumb" },
      encoding: "utf8",
    },
  );
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim().split(/\r?\n/);
}
