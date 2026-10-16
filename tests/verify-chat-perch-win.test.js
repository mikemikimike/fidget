// scripts/verify-chat-perch-win.ps1 decides each #1502 check from trace lines
// and UI Automation frames. Only its pure functions are loaded, through the
// PowerShell parser, so no window or app launch runs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

import { resolvePwsh } from "./pwsh-resolve.js";

const script = join(
  import.meta.dirname,
  "..",
  "scripts",
  "verify-chat-perch-win.ps1",
);
const resolved = resolvePwsh();
const skip = resolved.kind === "ready" ? false : resolved.reason;

function run(body) {
  const loader = `
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:CHAT_PERCH_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "parse errors: $($errors | Out-String)" }
foreach ($fn in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -in "Test-PerchedFrames", "Test-ClickTraced", "Get-AskInstance", "Get-ButtonRect", "Test-RectInside" }, $true)) {
  Invoke-Expression $fn.Extent.Text
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
      env: { ...process.env, CHAT_PERCH_SCRIPT: script, TERM: "dumb" },
      encoding: "utf8",
    },
  );
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim().split(/\r?\n/);
}

const perched = (y) =>
  `17 frame: 17 Perched pos(1720,${y}) sprite(1657,32) land#1 id`;

test(
  "five Perched frames on the ledge pass; a Falling tail or an off-ledge y does not",
  { skip },
  () => {
    const ok = Array(5)
      .fill(perched(160))
      .map((l) => `'${l}'`)
      .join(",");
    const falling = [
      ...Array(4).fill(`'${perched(160)}'`),
      `'17 frame: 18 Falling pos(1720,160) sprite(0,0) fall#0 id'`,
    ].join(",");
    const off = Array(5)
      .fill(`'${perched(200)}'`)
      .join(",");
    assert.deepEqual(
      run(`
@(Test-PerchedFrames @(${ok}) 160 1502 436).Count
$null -eq (Test-PerchedFrames @(${falling}) 160 1502 436)
$null -eq (Test-PerchedFrames @(${off}) 160 1502 436)`),
      ["5", "True", "True"],
    );
  },
);

test("the click counts only for the asking Character", { skip }, () => {
  assert.deepEqual(
    run(`
$lines = @('overlay overlay-0: showAsk instance=a1 dnd=off', 'bubble: open-chat invoked instance=b2')
Get-AskInstance $lines
Test-ClickTraced $lines 'a1'
Test-ClickTraced $lines 'b2'`),
    ["a1", "False", "True"],
  );
});

test(
  "the chat button rect is read from the dump and must sit inside Chat",
  { skip },
  () => {
    assert.deepEqual(
      run(`
$button = Get-ButtonRect @('other|Question for you in the |1636,183,143,18', 'button|chat|1778,182,26,21') 'chat'
$button -join ','
Test-RectInside $button @(1502, 160, 436, 599)
Test-RectInside $button @(1502, 190, 436, 599)`),
      ["1778,182,26,21", "True", "False"],
    );
  },
);
