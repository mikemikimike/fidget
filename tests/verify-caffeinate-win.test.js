// scripts/verify-caffeinate-win.ps1 decides each check from
// `powercfg /requests` output and Fidget's stderr. Only its pure functions are
// loaded, through the PowerShell parser, so no app launch or powercfg runs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { resolvePwsh } from "./pwsh-resolve.js";
import { tempDir } from "./temp-path.js";

const script = join(
  import.meta.dirname,
  "..",
  "scripts",
  "verify-caffeinate-win.ps1",
);
const resolved = resolvePwsh();
const skip = resolved.kind === "ready" ? false : resolved.reason;

function run(body, env = {}) {
  const loader = `
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:CAFFEINATE_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "parse errors: $($errors | Out-String)" }
$reason = $ast.Find({ $args[0] -is [System.Management.Automation.Language.AssignmentStatementAst] -and $args[0].Left.Extent.Text -eq '$FidgetReason' }, $true)
Invoke-Expression $reason.Extent.Text
$flip = $ast.Find({ $args[0] -is [System.Management.Automation.Language.AssignmentStatementAst] -and $args[0].Left.Extent.Text -eq '$HitFlipPattern' }, $true)
Invoke-Expression $flip.Extent.Text
$miss = $ast.Find({ $args[0] -is [System.Management.Automation.Language.AssignmentStatementAst] -and $args[0].Left.Extent.Text -eq '$MissFlipPattern' }, $true)
Invoke-Expression $miss.Extent.Text
foreach ($fn in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -in "Get-PowerRequests", "Test-FidgetRequest", "Get-CaffeinatePattern", "Get-OnPattern", "Get-OtherChatPattern", "Get-PeSubsystem", "Get-PressPattern", "Get-UncaughtLines", "Press", "Get-FramePattern", "Get-ChatInstance", "Get-DpiScale", "Get-ClickThrough", "Get-SpritePoint" }, $true)) {
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
      env: { ...process.env, CAFFEINATE_SCRIPT: script, TERM: "dumb", ...env },
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

test("another process's power request is not Fidget's", { skip }, () => {
  assert.deepEqual(
    run(`
$lines = @('SYSTEM:', '[DRIVER] Realtek High Definition Audio', 'An audio stream is in use.', '', 'DISPLAY:', '[PROCESS] \\Device\\HarddiskVolume3\\Program Files\\Mozilla Firefox\\firefox.exe', 'Playing video')
Test-FidgetRequest $lines 'SYSTEM'
Test-FidgetRequest $lines 'DISPLAY'`),
    ["False", "False"],
  );
});

test("the reason alone names Fidget's power request", { skip }, () => {
  assert.deepEqual(
    run(
      `Test-FidgetRequest @('SYSTEM:', '[SERVICE] \\Device\\x\\svchost.exe', 'Fidget: keep my computer awake') 'SYSTEM'`,
    ),
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

test("a flag change waits for the power requests it turns on", { skip }, () => {
  assert.deepEqual(
    run(`
'caffeinate: on (SYSTEM)' -match (Get-OnPattern 'SYSTEM')
'caffeinate: on (DISPLAY, SYSTEM)' -match (Get-OnPattern 'SYSTEM')
'caffeinate: on (DISPLAY, SYSTEM)' -match (Get-OnPattern 'DISPLAY, SYSTEM')
'caffeinate: off' -match (Get-OnPattern 'SYSTEM')
'caffeinate: on (SYSTEM)' -match (Get-CaffeinatePattern 'on')
'caffeinate: off' -match (Get-CaffeinatePattern 'off')`),
    ["True", "False", "True", "False", "False", "False"],
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

// WebView2 gives a toggle button such as the cup (`aria-pressed`) Toggle and
// no Invoke, so pressing it through Invoke threw and ended the run with an
// empty result.txt.
test(
  "a press picks Toggle, then Invoke, and neither when both are missing",
  { skip },
  () => {
    assert.deepEqual(
      run(`
Get-PressPattern @('TogglePatternIdentifiers.Pattern', 'LegacyIAccessiblePatternIdentifiers.Pattern')
Get-PressPattern @('InvokePatternIdentifiers.Pattern', 'TogglePatternIdentifiers.Pattern')
Get-PressPattern @('InvokePatternIdentifiers.Pattern')
"[$(Get-PressPattern @('LegacyIAccessiblePatternIdentifiers.Pattern'))]"
"[$(Get-PressPattern @())]"`),
      ["Toggle", "Toggle", "Invoke", "[]", "[]"],
    );
  },
);

test("no UI Automation call throws on a missing pattern", () => {
  const text = readFileSync(script, "utf8");
  assert.doesNotMatch(text, /[^y]GetCurrentPattern\(/);
});

// Runs the script's own top-level catch around a throw, so the check is on the
// block the run uses, not a copy of it.
test(
  "an uncaught error lands in result.txt with its stack trace",
  { skip },
  (t) => {
    const dir = tempDir(t, "caffeinate-win-");
    const result = join(dir, "result.txt");
    const out = spawnSync(
      resolved.command,
      [
        ...(resolved.args ?? []),
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:CAFFEINATE_SCRIPT, [ref]$tokens, [ref]$errors)
foreach ($fn in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq "Get-UncaughtLines" }, $true)) {
  Invoke-Expression $fn.Extent.Text
}
$main = @($ast.EndBlock.Statements)[-1]
if ($main -isnot [System.Management.Automation.Language.TryStatementAst] -or $main.CatchClauses.Count -ne 1) { Write-Error "the script does not end in one try/catch"; exit 3 }
$result = $env:RESULT; $out = $env:RESULT
$ErrorActionPreference = "Stop"
Invoke-Expression ("try { throw 'boom' } " + $main.CatchClauses[0].Extent.Text)`,
      ],
      {
        env: {
          ...process.env,
          CAFFEINATE_SCRIPT: script,
          RESULT: result,
          TERM: "dumb",
        },
        encoding: "utf8",
      },
    );
    assert.equal(out.status, 1, out.stderr);
    const lines = readFileSync(result, "utf8").trim().split(/\r?\n/);
    assert.equal(lines[0], "FAIL: boom");
    assert.match(lines[1], /^at /);
  },
);

// UI Automation stand-ins: "stale" is an element Settings has redrawn away
// (no patterns), "fresh" a live checkbox. The watch counts the structure
// changes Press waits on.
const stubs = `
Add-Type @'
public sealed class StubWatch : System.IDisposable {
    public int Waits;
    public bool Next(int ms) { Waits++; return true; }
    public void Dispose() { }
}
public static class CaffeinateWin {
    public static string Pressed = "";
    public static StubWatch Watch = new StubWatch();
    public static StubWatch WatchStructure(System.IntPtr hwnd) { return Watch; }
    public static string[] Patterns(object e) {
        return (string)e == "fresh" ? new[] { "TogglePatternIdentifiers.Pattern" } : new string[0];
    }
    public static bool Toggle(object e) { Pressed += e + ";"; return true; }
    public static bool Invoke(object e) { Pressed += "invoke " + e + ";"; return true; }
}
'@
function Fail([string]$Message) { "FAIL: $Message"; exit 0 }`;

// Run r4: the Display checkbox pressed once, Settings redrew the tab, and the
// second press went to the element found before the redraw.
test("a press finds its element again after the next redraw", { skip }, () => {
  assert.deepEqual(
    run(`${stubs}
$script:finds = 0
Press ([IntPtr]::Zero) { $script:finds++; if ($script:finds -eq 1) { "stale" } else { "fresh" } } "the Display checkbox"
"finds=$script:finds waits=$([CaffeinateWin]::Watch.Waits) pressed=$([CaffeinateWin]::Pressed)"`),
    ["finds=2 waits=1 pressed=fresh;"],
  );
});

test(
  "a press that never finds a live element fails naming its patterns",
  { skip },
  () => {
    assert.deepEqual(
      run(`${stubs}
Press ([IntPtr]::Zero) { "stale" } "the Display checkbox"
"not reached"`),
      [
        "FAIL: the Display checkbox supports neither Toggle nor Invoke; it supports: none",
      ],
    );
  },
);

// Every press goes through a finder, so none reuses an element held across a
// state change.
test("every press passes a finder, not a held element", () => {
  const presses = [
    ...readFileSync(script, "utf8").matchAll(/^\s*Press (\S+) (\S)/gm),
  ];
  assert.ok(presses.length >= 3, `found ${presses.length} presses`);
  for (const [line, , finder] of presses) assert.equal(finder, "{", line);
});

// Scenario waits wake on UI Automation events, stderr lines or the process
// exiting, never on a timer.
test("no wait sleeps or polls the clock", () => {
  const text = readFileSync(script, "utf8").replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(text, /Start-Sleep|Thread\.Sleep|\bsleep\b/i);
  assert.doesNotMatch(text, /\(Get-Date\)\.Add/);
});

// The aim at Mochi reads frame_loop's trace lines: `frame:` for where a sprite
// stands, `hit-test:` for the click-through flips. The scale comes from the
// primary display's DPI, not the trace, which rounds it to one place.
const beemo = "0b1c2d3e-0000-4000-8000-00000000000a";
const mochi = "9f8e7d6c-0000-4000-8000-00000000000b";
const frame = (state, pos, sprite, id) =>
  `'frame: 1761234567890 ${state} pos(${pos}) sprite(${sprite}) walk#3 ${id}'`;

test("Mochi is the Instance that is not Beemo, standing", { skip }, () => {
  assert.deepEqual(
    run(`
$beemo = Get-ChatInstance 'chat-${beemo}'
$beemo
${frame("Grounded", "400,900", "344,790", mochi)} -match (Get-FramePattern $beemo -Except)
${frame("Grounded", "400,900", "344,790", beemo)} -match (Get-FramePattern $beemo -Except)
${frame("Falling", "400,900", "344,790", mochi)} -match (Get-FramePattern $beemo -Except)
${frame("Perched", "-12,40", "-68,-70", beemo)} -match (Get-FramePattern $beemo)
${frame("Grounded", "400,900", "344,790", mochi)} -match (Get-FramePattern $beemo)`),
    [beemo, "True", "False", "False", "True", "False"],
  );
});

// The trace's `scale 1.2` at 125% is 4% short of the DPI.
test("the scale is the DPI over 96, exact at 125% and 175%", { skip }, () => {
  assert.deepEqual(
    run(`
Get-DpiScale 96
Get-DpiScale 120
Get-DpiScale 144
Get-DpiScale 168
Get-DpiScale 0`),
    ["1", "1.25", "1.5", "1.75", "0"],
  );
});

test("the click lands halfway down the sprite, in pixels", { skip }, () => {
  assert.deepEqual(
    run(`
Get-SpritePoint ${frame("Grounded", "400,900", "344,790", mochi)} (Get-DpiScale 120)
Get-SpritePoint ${frame("Grounded", "400,900", "344,790", mochi)} 1
Get-SpritePoint ${frame("Grounded", "-400,900", "-456,790", mochi)} 1.5
"[$(Get-SpritePoint 'chat: x is open' 1)]"`),
    ["500,1056", "400,845", "-600,1268", "[]"],
  );
});

test("the aim waits on the overlay's click-through flips", { skip }, () => {
  const hit =
    "'hit-test: cursor(500,1056) scale 1.2 -> point(400,845) on overlay 0 HIT  click-through OFF";
  const miss =
    "'hit-test: cursor(3,3) scale 1.2 -> point(2,2) on overlay 0 miss click-through on";
  assert.deepEqual(
    run(`
${hit}  <- flipped' -match $HitFlipPattern
${hit}' -match $HitFlipPattern
${miss}  <- flipped' -match $HitFlipPattern
${miss}  <- flipped' -match $MissFlipPattern
${hit}  <- flipped' -match $MissFlipPattern
Get-ClickThrough "${hit.slice(1)}"
Get-ClickThrough "${miss.slice(1)}  <- flipped"
"[$(Get-ClickThrough 'click: down hits=[]')]"`),
    ["True", "False", "False", "True", "False", "OFF", "on", "[]"],
  );
});

// The run is unattended: no step waits on a person, and Mochi's Chat opens
// from a real double-click the script sends itself.
test("no step asks for a hand", () => {
  const text = readFileSync(script, "utf8");
  assert.match(text, /^# Input: none, apart from accepting UAC\./m);
  assert.doesNotMatch(
    text,
    /Double-click Mochi|by hand|by-hand|when asked|Read-Host|Waiting up to/i,
  );
});

test("Mochi's Chat opens from a SendInput double-click", () => {
  const text = readFileSync(script, "utf8");
  assert.match(text, /static extern uint SendInput\(/);
  assert.match(text, /GetDoubleClickTime\(\)/);
  assert.match(text, /\[CaffeinateWin\]::LeftClicks\(\$tee, 2\)/);
});

// The C# goes to Add-Type verbatim. In a double-quoted here-string PowerShell
// expands `n and $x, which broke the compile on Windows (`n` in a comment).
test("Add-Type C# source is a literal here-string", () => {
  const text = readFileSync(script, "utf8");
  const addTypes = [...text.matchAll(/Add-Type\b[^\n]*@(["'])$/gm)];
  assert.ok(addTypes.length > 0);
  for (const [line, quote] of addTypes) assert.equal(quote, "'", line);
});
