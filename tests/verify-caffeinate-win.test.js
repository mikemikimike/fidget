// scripts/verify-caffeinate-win.ps1 decides each #1788 check from
// `powercfg /requests` output and Fidget's stderr. Only its pure functions are
// loaded, through the PowerShell parser, so no app launch or powercfg runs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

import { resolvePwsh } from "./pwsh-resolve.js";

const script = join(
  import.meta.dirname,
  "..",
  "scripts",
  "verify-caffeinate-win.ps1",
);
const resolved = resolvePwsh();
const skip = resolved.kind === "ready" ? false : resolved.reason;

function run(body) {
  const loader = `
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:CAFFEINATE_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "parse errors: $($errors | Out-String)" }
$reason = $ast.Find({ $args[0] -is [System.Management.Automation.Language.AssignmentStatementAst] -and $args[0].Left.Extent.Text -eq '$FidgetReason' }, $true)
Invoke-Expression $reason.Extent.Text
foreach ($fn in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -in "Get-PowerRequests", "Test-FidgetRequest", "Get-CaffeinatePattern", "Get-SetPattern", "Get-OtherChatPattern", "Get-PeSubsystem" }, $true)) {
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
      env: { ...process.env, CAFFEINATE_SCRIPT: script, TERM: "dumb" },
      encoding: "utf8",
    },
  );
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim().split(/\r?\n/);
}

// The shape `powercfg /requests` prints, one entry under DISPLAY.
const listed = (section) =>
  ["DISPLAY", "SYSTEM", "AWAYMODE", "EXECUTION", "PERFMON", "ACTIVELOCKSCREEN"]
    .flatMap((name) =>
      name === section
        ? [
            `${name}:`,
            "[PROCESS] \\Device\\HarddiskVolume3\\src\\fidget\\target\\debug\\fidget.exe",
            "Fidget: keep my computer awake",
            "",
          ]
        : [`${name}:`, "None.", ""],
    )
    .map((line) => `'${line}'`)
    .join(",");

test("a Fidget entry counts only under its own section", { skip }, () => {
  assert.deepEqual(
    run(`
$lines = @(${listed("DISPLAY")})
Test-FidgetRequest $lines 'DISPLAY'
Test-FidgetRequest $lines 'SYSTEM'
(Get-PowerRequests $lines)['SYSTEM'].Count`),
    ["True", "False", "0"],
  );
});

test("another process's request is not Fidget's", { skip }, () => {
  assert.deepEqual(
    run(`
$lines = @('SYSTEM:', '[DRIVER] Realtek High Definition Audio', 'An audio stream is in use.', '', 'DISPLAY:', '[PROCESS] \\Device\\HarddiskVolume3\\Program Files\\Mozilla Firefox\\firefox.exe', 'Playing video')
Test-FidgetRequest $lines 'SYSTEM'
Test-FidgetRequest $lines 'DISPLAY'`),
    ["False", "False"],
  );
});

test("the reason alone names Fidget's request", { skip }, () => {
  assert.deepEqual(
    run(`Test-FidgetRequest @('SYSTEM:', '[SERVICE] \\Device\\x\\svchost.exe', 'Fidget: keep my computer awake') 'SYSTEM'`),
    ["True"],
  );
});

test("the waits match frame_loop's caffeinate lines", { skip }, () => {
  assert.deepEqual(
    run(`
'caffeinate: ☕ Caffeinate on: keeping your computer awake (-dims)' -match (Get-CaffeinatePattern 'on')
'caffeinate: Caffeinate off.' -match (Get-CaffeinatePattern 'off')
'caffeinate: Caffeinate off.' -match (Get-CaffeinatePattern 'on')
'caffeinate: Caffeinate on: x' -match (Get-CaffeinatePattern 'off')`),
    ["True", "True", "False", "False"],
  );
});

test("a flag change waits for the power request it should set", { skip }, () => {
  assert.deepEqual(
    run(`
'caffeinate: power request set: SYSTEM' -match (Get-SetPattern 'SYSTEM')
'caffeinate: power request set: DISPLAY, SYSTEM' -match (Get-SetPattern 'SYSTEM')
'caffeinate: power request set: DISPLAY, SYSTEM' -match (Get-SetPattern 'DISPLAY, SYSTEM')
'caffeinate: power request cleared' -match (Get-SetPattern 'SYSTEM')`),
    ["True", "False", "True", "False"],
  );
});

test("the second Chat is any Chat but the first", { skip }, () => {
  assert.deepEqual(
    run(`
'chat: chat-a1 is open' -match (Get-OtherChatPattern 'chat-a1')
'chat: chat-b2 is open' -match (Get-OtherChatPattern 'chat-a1')
'chat: chat-a12 is open' -match (Get-OtherChatPattern 'chat-a1')
'chat: chat-b2 could not be raised: x' -match (Get-OtherChatPattern 'chat-a1')`),
    ["False", "True", "True", "False"],
  );
});

test("only a console exe passes the Ctrl+C precheck", { skip }, () => {
  // The smallest header Get-PeSubsystem reads: MZ, e_lfanew, the PE signature.
  const pe = (subsystem) => `
$b = New-Object byte[] 256; $b[0] = 0x4D; $b[1] = 0x5A; $b[0x3C] = 0x40
$b[0x40] = 0x50; $b[0x41] = 0x45; $b[0x40 + 92] = ${subsystem}
Get-PeSubsystem $b`;
  assert.deepEqual(
    run(`${pe(3)}
${pe(2)}
Get-PeSubsystem ([byte[]](0x23, 0x21) * 40)`),
    ["3", "2", "0"],
  );
});
