#!/usr/bin/env pwsh
# Scenario: caffeinate (Windows), the power request behind the Chat cup (#1788).
# On screen: one Fidget/BMO instance with Chat open. The script presses the
#   cup through UI Automation (no mouse), and Fidget is ended at the end.
# Needs: an elevated PowerShell, because `powercfg /requests` refuses without
#   admin rights, and no other Fidget running.
# Duration: about 1 min with a built exe.
# Asserts: `powercfg /requests` lists fidget.exe under SYSTEM and DISPLAY
#   after the cup turns caffeinate on, under neither after it turns it off,
#   and under neither once the process has ended with caffeinate on.
# Waits: on Fidget's stderr lines (Get-Content -Wait), UI Automation
#   structure events, and Wait-Process. No sleep loops.
# Isolation: FIDGET_DATA_DIR, HOME, APPDATA, LOCALAPPDATA, TEMP, TMP and
#   WEBVIEW2_USER_DATA_FOLDER all point under the evidence directory.
#
# Usage: verify-caffeinate-win.ps1 --go <evidence dir> [<fidget.exe>] [--quit-by-hand]
# Without <fidget.exe> it runs `cargo build -p fidget` and uses that exe.
# --quit-by-hand waits for you to pick Quit in the tray menu instead of
#   ending the process.
# Without --go it prints this header and exits 2.
# No param() block: Windows PowerShell binds `--go` as -Go (see question-bubble.win.ps1).
$Go = if ($args.Count -gt 0) { $args[0] } else { "" }
$ErrorActionPreference = "Stop"

# The reason `caffeinate_win::REASON` gives the request.
$FidgetReason = "Fidget: keep my computer awake"

# Pure checks, loaded on their own by tests/verify-caffeinate-win.test.js.
function Get-PowerRequests([string[]]$Lines) {
    $sections = @{}
    $current = $null
    foreach ($line in $Lines) {
        $text = $line.Trim()
        if ($text -match '^([A-Z]+):$') {
            $current = $Matches[1]
            $sections[$current] = @()
        } elseif ($current -and $text -and $text -ne "None.") {
            $sections[$current] += $text
        }
    }
    return $sections
}

function Test-FidgetRequest([string[]]$Lines, [string]$Section) {
    $entries = @((Get-PowerRequests $Lines)[$Section])
    [bool]($entries | Where-Object { $_ -match '\\fidget\.exe$' -or $_ -ceq $FidgetReason })
}

# The stderr line frame_loop prints for each caffeinate Note.
function Get-CaffeinatePattern([string]$State) {
    if ($State -eq "on") { '^caffeinate: .*Caffeinate on:' } else { '^caffeinate: Caffeinate off\.$' }
}

if ($Go -ne "--go") {
    $header = @()
    foreach ($line in (Get-Content -LiteralPath $PSCommandPath | Select-Object -Skip 1)) {
        if (-not $line.StartsWith("#")) { break }
        $header += ($line -replace '^# ?', '')
    }
    $header -join "`n"
    exit 2
}
$rest = @($args | Select-Object -Skip 1)
$QuitByHand = $rest -contains "--quit-by-hand"
$positional = @($rest | Where-Object { $_ -ne "--quit-by-hand" })
if ($positional.Count -lt 1 -or $positional.Count -gt 2) {
    Write-Error "usage: verify-caffeinate-win.ps1 --go <evidence dir> [<fidget.exe>] [--quit-by-hand]"
    exit 1
}
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "powercfg /requests needs an elevated PowerShell. Run this again as administrator."
    exit 1
}

if ($positional.Count -eq 2) {
    $Bin = (Resolve-Path -LiteralPath $positional[1]).Path
} else {
    & cargo build -p fidget --manifest-path (Join-Path $root "Cargo.toml")
    if ($LASTEXITCODE -ne 0) { Write-Error "cargo build -p fidget failed"; exit 1 }
    $targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root "target" }
    $Bin = Join-Path $targetDir "debug\fidget.exe"
}

$out = Join-Path $positional[0] ("caffeinate-win-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$data = Join-Path $out "data"
$homeDir = Join-Path $out "home"
foreach ($d in $data, "$homeDir\AppData\Roaming", "$homeDir\AppData\Local", "$out\tmp", "$out\webview2") {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}
$result = Join-Path $out "result.txt"
$stdout = Join-Path $out "app.log"
$stderr = Join-Path $out "app.err"
Set-Content -LiteralPath $result -Value "" -Encoding ascii
Set-Content -LiteralPath $stderr -Value "" -Encoding ascii
$proc = $null

function Fail([string]$Message) {
    Add-Content -LiteralPath $result -Value "FAIL: $Message"
    [Console]::Error.WriteLine("FAIL: $Message")
    [Console]::Error.WriteLine("Evidence: $out")
    exit 1
}
function Pass([string]$Check, [string]$Detail) {
    Add-Content -LiteralPath $result -Value "$Check=pass $Detail"
    Write-Output "PASS $Check $Detail"
}
if (-not (Test-Path -LiteralPath $Bin)) { Fail "missing $Bin" }

# One powercfg snapshot, kept as evidence under `$Label`.
function Requests([string]$Label) {
    $lines = @(& powercfg /requests)
    if ($LASTEXITCODE -ne 0) { Fail "powercfg /requests exited $LASTEXITCODE" }
    $lines | Set-Content -LiteralPath (Join-Path $out "powercfg-$Label.txt") -Encoding utf8
    $lines
}
function Expect-Requests([string]$Label, [bool]$System, [bool]$Display) {
    $lines = Requests $Label
    $got = "SYSTEM=$(Test-FidgetRequest $lines 'SYSTEM') DISPLAY=$(Test-FidgetRequest $lines 'DISPLAY')"
    $want = "SYSTEM=$System DISPLAY=$Display"
    if ($got -ne $want) { Fail "$Label wants $want, powercfg shows $got; see $out\powercfg-$Label.txt" }
    Pass $Label $got
}

# Blocks on a tail of Fidget's stderr until a line matches `$Pattern`, or the
# timeout. `Get-Content -Wait` delivers lines as they land.
function Wait-Line([int]$Skip, [int]$Seconds, [string]$Pattern) {
    $job = Start-Job -ArgumentList $stderr, $Skip, $Pattern -ScriptBlock {
        param($File, $Skip, $Pattern)
        Get-Content -LiteralPath $File -Wait | Select-Object -Skip $Skip |
            Where-Object { $_ -match $Pattern } | Select-Object -First 1
    }
    try {
        if (-not (Wait-Job -Job $job -Timeout $Seconds)) { return $null }
        return Receive-Job -Job $job
    } finally {
        Remove-Job -Job $job -Force
    }
}
function Line-Count { @(Get-Content -LiteralPath $stderr).Count }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase @"
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public static class CaffeinateWin {
    public delegate bool Callback(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    // Chat is the visible window titled other than the overlays' "Fidget".
    public static IntPtr FindChat(uint pid) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => {
            uint owner; GetWindowThreadProcessId(h, out owner);
            if (owner != pid || !IsWindowVisible(h)) return true;
            var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
            if (sb.Length > 0 && sb.ToString() != "Fidget") { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    static AutomationElement FindCup(AutomationElement root) {
        return root.FindFirst(TreeScope.Descendants, new AndCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
            new PropertyCondition(AutomationElement.NameProperty, "Caffeinate")));
    }
    // The cup stays hidden, so out of the tree, until the first view lands.
    // The handler wakes the wait when the page's tree changes.
    public static AutomationElement WaitCup(IntPtr hwnd, int ms) {
        var root = AutomationElement.FromHandle(hwnd);
        var changed = new AutoResetEvent(false);
        StructureChangedEventHandler handler = (s, e) => changed.Set();
        Automation.AddStructureChangedEventHandler(root, TreeScope.Subtree, handler);
        try {
            var deadline = DateTime.UtcNow.AddMilliseconds(ms);
            while (true) {
                var cup = FindCup(root);
                var left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                if (cup != null || left <= 0) return cup;
                changed.WaitOne(left);
            }
        } finally {
            Automation.RemoveStructureChangedEventHandler(root, handler);
        }
    }
    public static void Press(AutomationElement cup) {
        ((InvokePattern)cup.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
    }
}
"@

$before = Requests "before-launch"
if ((Test-FidgetRequest $before "SYSTEM") -or (Test-FidgetRequest $before "DISPLAY")) {
    Fail "a Fidget power request is already listed; quit the other Fidget first"
}

$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $data "settings.json"),
    '{"hide_in_fullscreen": false, "first_run_tour_shown": true}', $utf8)
$env:FIDGET_DATA_DIR = $data
$env:HOME = $homeDir
$env:USERPROFILE = $homeDir
$env:APPDATA = "$homeDir\AppData\Roaming"
$env:LOCALAPPDATA = "$homeDir\AppData\Local"
$env:TEMP = "$out\tmp"
$env:TMP = "$out\tmp"
$env:WEBVIEW2_USER_DATA_FOLDER = "$out\webview2"
$env:FIDGET_OPEN_CHAT = "1"
# Prints the "chat: ... is open" line the first wait blocks on.
$env:FIDGET_TRACE_BUBBLE = "1"
$env:FIDGET_CHARACTER = "bmo"
$env:FIDGET_CHARACTERS = Join-Path $root "characters"

$proc = Start-Process -FilePath $Bin -WorkingDirectory $out -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
@("pid=$($proc.Id)", "commit=$(git -C $root rev-parse HEAD)", "bin=$Bin") |
    Set-Content -LiteralPath (Join-Path $out "run.txt")
try {
    if (-not (Wait-Line 0 60 '^chat: \S+ is open$')) { Fail "Chat did not open; see $stderr" }
    $chat = [CaffeinateWin]::FindChat([uint32]$proc.Id)
    if ($chat -eq [IntPtr]::Zero) { Fail "no Chat window for pid $($proc.Id)" }
    $cup = [CaffeinateWin]::WaitCup($chat, 30000)
    if ($null -eq $cup) { Fail "Chat has no Caffeinate button" }
    Pass "cup" "found in Chat"

    $skip = Line-Count
    [CaffeinateWin]::Press($cup)
    if (-not (Wait-Line $skip 10 (Get-CaffeinatePattern "on"))) { Fail "no 'Caffeinate on' line; see $stderr" }
    Expect-Requests "on" $true $true

    $skip = Line-Count
    [CaffeinateWin]::Press($cup)
    if (-not (Wait-Line $skip 10 (Get-CaffeinatePattern "off"))) { Fail "no 'Caffeinate off' line; see $stderr" }
    Expect-Requests "off" $false $false

    $skip = Line-Count
    [CaffeinateWin]::Press($cup)
    if (-not (Wait-Line $skip 10 (Get-CaffeinatePattern "on"))) { Fail "no second 'Caffeinate on' line; see $stderr" }
    Expect-Requests "on-again" $true $true

    if ($QuitByHand) {
        Write-Output "Pick Quit in Fidget's tray menu now. Waiting up to 5 minutes."
        Wait-Process -Id $proc.Id -Timeout 300 -ErrorAction SilentlyContinue
        if (-not $proc.HasExited) { Fail "Fidget did not quit within 5 minutes" }
    } else {
        Stop-Process -Id $proc.Id -Force
        Wait-Process -Id $proc.Id -Timeout 30 -ErrorAction SilentlyContinue
        if (-not $proc.HasExited) { Fail "Fidget did not end" }
    }
    Expect-Requests "after-quit" $false $false

    Write-Output "PASS: the request follows the cup and goes with the process; evidence in $out"
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
