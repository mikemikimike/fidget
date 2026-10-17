#!/usr/bin/env pwsh
# Scenario: chat-close-pill-type (Windows)
# On screen: Notepad on a uniquely named scratch file, as a tab of a Notepad
#   already open or a window of its own, and Fidget as a standing BMO with the
#   fixture Harness. Cleanup closes only that tab (and the window if this run
#   opened Notepad), so it never comes back in Notepad's restored session.
# Input: SendInput cursor moves, clicks, typed words, Escape, Ctrl+Home, Ctrl+S.
#   Each press is held until Fidget traces it down; each word is one SendInput.
# Duration: about 15 s (an estimate until the first Windows run). Every wait
#   gives up 3 s after its trigger, except Fidget's first frame and the overlay's
#   first report, which get 10 s each.
# Grants: a desktop session with no Fidget running (it skips otherwise). Other
#   Notepad tabs and windows, and any fullscreen app, stay as they are; a
#   fullscreen window is only logged. bash for the fixture Harness wrapper.
# Asserts: (1) a sprite click leaves typing in Notepad; (2) hover opens the
#   pill, Fidget prints the pill-open SetForegroundWindow line, and "two" lands
#   in the pill (text="two" focused=true); (3) Escape closes the pill; (4) a
#   click into Notepad takes focus off the pill and typing lands in Notepad.
#   It prints the pill-open line, which says whether Windows refused the pill
#   the foreground (#1577).
# Self-checks that launch nothing: FIDGET_SCENARIO_NOTEPAD_TABS (names split by
#   |), FIDGET_SCENARIO_DOC and FIDGET_SCENARIO_NOTEPAD_BEFORE=1|0 print the
#   Notepad cleanup plan; FIDGET_SCENARIO_READY_LOG=<process.log> prints whether
#   the overlay was listening; FIDGET_SCENARIO_AIM_LOG=<process.log> prints the
#   sprite's middle; FIDGET_SCENARIO_TRACE_LINE=<line> prints which waited-on
#   trace patterns it matches; FIDGET_SCENARIO_PREPARE_ONLY=1 makes the run
#   folder and stops.
# Each run writes to a new chat-close-pill-type-<time>-<hex> folder in
#   [evidence dir], or in $env:TEMP without one.
#
# Usage: chat-close-pill-type.win.ps1 --go <fidget binary> <fidget test binary> [evidence dir]
# Without --go it prints this header, which is the takeover prompt, and exits 2.
# No param() block: Windows PowerShell would bind `--go` as -Go.
$Go = if ($args.Count -gt 0) { $args[0] } else { "" }
$Bin = if ($args.Count -gt 1) { $args[1] } else { "" }
$TestBin = if ($args.Count -gt 2) { $args[2] } else { "" }
$Out = if ($args.Count -gt 3) { $args[3] } else { "" }
$ErrorActionPreference = "Stop"

function Show-Header {
    $header = @()
    foreach ($line in Get-Content -LiteralPath $PSCommandPath | Select-Object -Skip 1) {
        if ($line.StartsWith("#")) { $header += ($line -replace '^# ?', '') } else { break }
    }
    $header -join "`n"
}
if ($Go -ne "--go") {
    Show-Header
    exit 2
}
if (-not $Bin -or -not $TestBin) {
    Write-Error "usage: chat-close-pill-type.win.ps1 --go <fidget binary> <fidget test binary> [evidence dir]"
    exit 1
}

# Every trace line a wait or assert reads, each matched to its eprintln! in
# src-tauri/src (main.rs, frame_loop.rs). Lines in process.log may carry a
# timestamp first.
$T = [ordered]@{
    frame     = '(?:^|\s)frame: \d+ '
    size      = '(?:^|\s)overlay: \d+ display\(s\); sprite (\d+)x(\d+);'
    listening = '(?:^|\s)overlay: draft instance=\S+ '
    opened    = '(?:^|\s)overlay: draft instance=\S+ text="" focused=true$'
    two       = '(?:^|\s)overlay: draft instance=\S+ text="two" focused=true$'
    unfocused = '(?:^|\s)overlay: draft instance=\S+ (?:text="[^"]*" focused=false|closed)$'
    closed    = '(?:^|\s)overlay: draft instance=\S+ closed$'
    pillOpen  = '(?:^|\s)overlay: pill open SetForegroundWindow\((0x[0-9a-f]+)\) -> (-?\d+) GetForegroundWindow\(\) -> (0x[0-9a-f]+)$'
    hit       = '(?:^|\s)hit-test: cursor\(.*\bHIT\s+click-through OFF'
    down      = '(?:^|\s)click: down '
    up        = '(?:^|\s)click: up '
}
# The pill's text, whatever its focus, holding $Word.
function Draft-Holds([string]$Word) { "(?:^|\s)overlay: draft instance=\S+ text=`"[^`"]*$Word[^`"]*`" " }

if ($null -ne $env:FIDGET_SCENARIO_TRACE_LINE) {
    $names = @($T.Keys | Where-Object { $env:FIDGET_SCENARIO_TRACE_LINE -match $T[$_] })
    Write-Output "matches: $($names -join ' ')"
    exit 0
}

# Cleanup's plan for Notepad, from its tab names: it closes only our tab, and the
# window too only when this run opened Notepad. Anything else fails loudly.
function Get-NotepadPlan([string[]]$Tabs, [string]$Ours, [bool]$WasRunning) {
    $mine = @($Tabs | Where-Object { $_.Contains($Ours) }).Count
    if ($mine -eq 0) { return "fail: no Notepad tab shows $Ours" }
    if ($mine -gt 1) { return "fail: Notepad already shows $Ours in $mine tabs" }
    if ($WasRunning) { return "close our tab only" }
    "close our tab, then the Notepad window this run opened"
}
if ($env:FIDGET_SCENARIO_NOTEPAD_TABS) {
    $plan = Get-NotepadPlan ($env:FIDGET_SCENARIO_NOTEPAD_TABS -split '\|') $env:FIDGET_SCENARIO_DOC ($env:FIDGET_SCENARIO_NOTEPAD_BEFORE -eq "1")
    if ($plan.StartsWith("fail: ")) {
        [Console]::Error.WriteLine("FAIL: $($plan.Substring(6))")
        exit 1
    }
    Write-Output "plan: $plan"
    exit 0
}
# The overlay's first draft report: its webview is listening, about 3 s after the
# Shell's first frame on Windows. Input before that reaches no pill.
function Test-OverlayListening([string[]]$Lines) {
    @($Lines | Where-Object { $_ -match $T.listening }).Count -gt 0
}
if ($env:FIDGET_SCENARIO_READY_LOG) {
    $ready = Test-OverlayListening (Get-Content -LiteralPath $env:FIDGET_SCENARIO_READY_LOG)
    Write-Output "ready: $(if ($ready) { 'yes' } else { 'no' })"
    exit 0
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
. (Join-Path $PSScriptRoot "wait-helpers.win.ps1")

# The middle of the sprite at rest: its top-left from the frame line, its size
# from the overlay's startup line. $null until both are there.
function Get-SpriteAim([string]$LogFile) {
    $at = Get-SpriteAtRest $LogFile
    if (-not $at) { return $null }
    $size = Get-Content -LiteralPath $LogFile | Where-Object { $_ -match $T.size } | Select-Object -First 1
    if (-not $size) { return $null }
    $null = $size -match $T.size
    @{ X = $at.X + [int]([int]$Matches[1] / 2); Y = $at.Y + [int]([int]$Matches[2] / 2) }
}
if ($env:FIDGET_SCENARIO_AIM_LOG) {
    $aim = Get-SpriteAim $env:FIDGET_SCENARIO_AIM_LOG
    Write-Output "aim: $(if ($aim) { "($($aim.X),$($aim.Y))" } else { 'none' })"
    exit 0
}

# Windows 11 Notepad is one process for every tab, so an open Notepad may hold the
# user's docs: the run adds a tab or window of its own and touches nothing else.
$notepadWasRunning = [bool](Get-Process -Name Notepad -ErrorAction SilentlyContinue)

$TestBin = (Resolve-Path -LiteralPath $TestBin).Path
# A fresh folder per run, under the given one or $env:TEMP, so a rerun keeps
# earlier evidence and nothing is ever cleared. New-Item stops if the name is taken.
$base = if ($Out) { $Out } else { $env:TEMP }
$Out = Join-Path $base "chat-close-pill-type-$(Get-Date -Format yyyyMMdd-HHmmss)-$((Get-Random -Maximum 65536).ToString('x4'))"
New-Item -ItemType Directory -Path $Out | Out-Null
$results = Join-Path $Out "results.txt"
$focusLog = Join-Path $Out "focus.log"
Set-Content -LiteralPath $results -Value $null
$script:proc = $null
$script:notepad = $null
$script:hwnd = [IntPtr]::Zero
$harnessTag = $null

function Fail([string]$Message) {
    [Console]::Error.WriteLine("FAIL: $Message")
    "FAIL: $Message" | Add-Content -LiteralPath $results
    [Console]::Error.WriteLine("evidence in $Out")
    throw "scenario failed"
}
function Ok([string]$Message) { "ok: $Message" | Tee-Object -FilePath $results -Append | Write-Output }

$log = Join-Path (Join-Path $Out "data") "process.log"
$marks = Join-Path $Out "harness.log"
Set-Content -LiteralPath $marks -Value "" -Encoding ascii
$docName = "fidget-pill-$(Get-Date -Format yyyyMMdd-HHmmss)-$((Get-Random -Maximum 65536).ToString('x4')).txt"
$doc = Join-Path $Out $docName
[System.IO.File]::WriteAllText($doc, "abc")
# A standing BMO: its own copy, with every walk played as idle.
$chars = Join-Path $Out "characters"
New-Item -ItemType Directory -Force -Path $chars | Out-Null
Copy-Item -Recurse (Join-Path (Join-Path $root "characters") "bmo") $chars
$manifest = Join-Path (Join-Path $chars "bmo") "character.manifest"
$standing = Get-Content -LiteralPath $manifest | ForEach-Object { if ($_ -match '^play = ') { $_ -replace '"walk"', '"idle"' } else { $_ } }
[System.IO.File]::WriteAllLines($manifest, [string[]]$standing)
if (Select-String -LiteralPath $manifest -Pattern '^play = .*"walk"' -Quiet) { Fail "BMO still walks in $manifest" }
# FIDGET_SCENARIO_PREPARE_ONLY stops here, with the run folder made and nothing launched.
if ($env:FIDGET_SCENARIO_PREPARE_ONLY) {
    Write-Output "prepared: $Out"
    exit 0
}
# A Fidget already here would share the overlay.
$already = @(Get-Process -Name fidget -ErrorAction SilentlyContinue | ForEach-Object { "fidget $($_.Id)" })
if ($already.Count) {
    [Console]::Error.WriteLine("SKIP: Fidget is already running: $($already -join ', ')")
    exit 2
}
. (Join-Path $PSScriptRoot "bash-setup-win.ps1")
if (-not $bashPath) {
    [Console]::Error.WriteLine("SKIP: bash not found (tried Git Bash, then PATH)")
    exit 2
}

Add-Type @"
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class PillWin {
    [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFOEX i);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT k; [FieldOffset(8)] public MOUSEINPUT m; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] i, int size);
    static void Send(INPUT[] all) {
        uint sent = SendInput((uint)all.Length, all, Marshal.SizeOf(typeof(INPUT)));
        if (sent != all.Length) throw new InvalidOperationException("SendInput sent " + sent + " of " + all.Length + " events, error " + Marshal.GetLastWin32Error());
    }
    public static void Key(ushort vk, bool up) { var i = new INPUT(); i.type = 1; i.k.vk = vk; i.k.flags = up ? 2u : 0u; Send(new[] { i }); }
    // A whole word as one SendInput call: each character's unicode down and up.
    public static void Text(string word) {
        var all = new List<INPUT>();
        foreach (char c in word) {
            var i = new INPUT(); i.type = 1; i.k.scan = c; i.k.flags = 4; all.Add(i);
            var j = new INPUT(); j.type = 1; j.k.scan = c; j.k.flags = 6; all.Add(j);
        }
        Send(all.ToArray());
    }
    public static void Button(bool up) { var i = new INPUT(); i.type = 0; i.m.flags = up ? 4u : 2u; Send(new[] { i }); }
    public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
    public static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
    public static IntPtr RootAt(int x, int y) { var p = new POINT(); p.X = x; p.Y = y; return GetAncestor(WindowFromPoint(p), 2); }
    public static MONITORINFOEX Monitor(IntPtr h) { var i = new MONITORINFOEX(); i.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX)); GetMonitorInfo(MonitorFromWindow(h, 2), ref i); return i; }
    public static List<IntPtr> Tops() {
        var all = new List<IntPtr>();
        EnumWindows((h, l) => { int v; bool cloaked = DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; if (IsWindowVisible(h) && !cloaked) all.Add(h); return true; }, IntPtr.Zero);
        return all;
    }
}
"@
# Per-monitor aware (-4), so cursor and window coordinates are the physical pixels
# Fidget traces. The process may already have an awareness set by its host, so
# this thread is set too, and checked: 2 is per-monitor.
$null = [PillWin]::SetProcessDpiAwarenessContext([IntPtr]-4)
$null = [PillWin]::SetThreadDpiAwarenessContext([IntPtr]-4)
$awareness = [PillWin]::GetAwarenessFromDpiAwarenessContext([PillWin]::GetThreadDpiAwarenessContext())
if ($awareness -ne 2) { Fail "this thread is not per-monitor DPI aware (awareness $awareness), so its pixels would not match Fidget's" }

function Proc-Name([uint32]$ProcessId) { $g = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue; if ($g) { $g.ProcessName } else { "?" } }
function Owner-Of([IntPtr]$H) { [uint32]$owner = 0; $null = [PillWin]::GetWindowThreadProcessId($H, [ref]$owner); $owner }
function Rect-Text($R) { "($($R.L),$($R.T))-($($R.R),$($R.B))" }
function Describe-Window([IntPtr]$H) {
    if ($H -eq [IntPtr]::Zero) { return "none" }
    $owner = Owner-Of $H
    $r = New-Object PillWin+RECT
    $null = [PillWin]::GetWindowRect($H, [ref]$r)
    "hwnd=0x$($H.ToString('x')) process=$owner ($(Proc-Name $owner)) class=$([PillWin]::Class($H)) title=`"$([PillWin]::Title($H))`" rect=$(Rect-Text $r) monitor=$([PillWin]::Monitor($H).szDevice)"
}
function Get-Fullscreen {
    foreach ($h in [PillWin]::Tops()) {
        if ([PillWin]::Class($h) -in @("Progman", "WorkerW")) { continue }
        $r = New-Object PillWin+RECT
        $null = [PillWin]::GetWindowRect($h, [ref]$r)
        $m = [PillWin]::Monitor($h).rcMonitor
        if ($r.L -le $m.L -and $r.T -le $m.T -and $r.R -ge $m.R -and $r.B -ge $m.B) { $h }
    }
}
function Note-Foreground([string]$When) { "foreground $When`: $(Describe-Window ([PillWin]::GetForegroundWindow()))" | Add-Content -LiteralPath $focusLog }

Note-Foreground "before the run"
# Evidence only: a fullscreen app keeps running, and nothing here focuses or moves it.
$full = @(Get-Fullscreen)
foreach ($h in $full) { "fullscreen: $(Describe-Window $h)" | Add-Content -LiteralPath $focusLog }
if (-not $full.Count) { "fullscreen: none" | Add-Content -LiteralPath $focusLog }

function Count([string]$Pattern) {
    if (-not (Test-Path -LiteralPath $log)) { return 0 }
    @(Get-Content -LiteralPath $log | Where-Object { $_ -match $Pattern }).Count
}
# Until $Test holds. NTFS can sit on change notices for a file Fidget holds open
# (3 s on run 20261017-141510), so besides each change it rechecks every 50 ms.
function Wait-Check([double]$Seconds, [scriptblock]$Test) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    $watcher = New-Object System.IO.FileSystemWatcher $Out
    $watcher.IncludeSubdirectories = $true
    try {
        while ($true) {
            if (& $Test) { return $true }
            if ($script:proc -and $script:proc.HasExited) { return $false }
            $left = [int]($deadline - (Get-Date)).TotalMilliseconds
            if ($left -le 0) { return $false }
            $null = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::All, [Math]::Min($left, 50))
        }
    } finally { $watcher.Dispose() }
}
function Wait-LogCount([double]$Seconds, [string]$Pattern, [int]$Before) {
    Wait-Check $Seconds { (Count $Pattern) -gt $Before }
}
# Counts first, then pulls the trigger, then waits 3 s for one more matching line.
function Wait-ForNext([string]$Pattern, [scriptblock]$Trigger) {
    $before = Count $Pattern
    & $Trigger
    Wait-LogCount 3 $Pattern $before
}
# Notepad in front with our tab the open one, so keys and Ctrl+S reach only our file.
function Foreground-Is { [PillWin]::GetForegroundWindow() -eq $script:hwnd -and [PillWin]::Title($script:hwnd).Contains($docName) }
$UiaEl = [System.Windows.Automation.AutomationElement]
$Gone = [System.Windows.Automation.ElementNotAvailableException]
function Keys-InNotepad {
    try {
        $f = $UiaEl::FocusedElement
        $f.Current.ProcessId -eq $script:notepad.Id -and $f.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document
    } catch [System.Windows.Automation.ElementNotAvailableException] { $false }
}
function Describe-Keys {
    try {
        $f = $UiaEl::FocusedElement
        "process=$($f.Current.ProcessId) ($(Proc-Name $f.Current.ProcessId)) type=$($f.Current.ControlType.ProgrammaticName) name=`"$($f.Current.Name)`""
    } catch [System.Windows.Automation.ElementNotAvailableException] { "an element that is already gone" }
}
function Note-Keys([string]$When) { Note-Foreground $When; "keys $When`: $(Describe-Keys)" | Add-Content -LiteralPath $focusLog }
# Fidget samples the button each frame, so the press is held until Fidget
# traces it down (any window: the sample is global), then released.
function Press-Hold([int]$X, [int]$Y, [string]$Case) {
    $null = [PillWin]::SetCursorPos($X, $Y)
    $downs = Count $T.down
    [PillWin]::Button($false)
    $seen = Wait-LogCount 3 $T.down $downs
    $ups = Count $T.up
    [PillWin]::Button($true)
    if (-not $seen) { Fail "${Case}: Fidget did not see the press at ($X,$Y) in 3 s; see $log" }
    if (-not (Wait-LogCount 3 $T.up $ups)) { Fail "${Case}: Fidget did not see the release at ($X,$Y) in 3 s; see $log" }
}
# A click only on our Notepad window, checked by the window under the point.
function Click-Notepad([int]$X, [int]$Y, [string]$Case) {
    $under = [PillWin]::RootAt($X, $Y)
    if ((Owner-Of $under) -ne $script:notepad.Id) { Fail "${Case}: refusing to click ($X,$Y): it would land on $(Describe-Window $under)" }
    Press-Hold $X $Y $Case
}
function Press([uint16]$Vk) { [PillWin]::Key($Vk, $false); [PillWin]::Key($Vk, $true) }
function Aim([string]$Case) {
    if (-not (Wait-Check 3 { ($script:aim = Get-SpriteAim $log) })) { Fail "${Case}: the sprite was not at rest with a known size in 3 s; see $log" }
}
function Move-Away { $null = [PillWin]::SetCursorPos($script:aim.X + 400, $script:aim.Y) }
# The overlay is click-through until its hit test sees the cursor, so the sprite is
# pressed once that line lands; a press 1.5 s late would meet a hover-opened pill.
function Click-Sprite([string]$Case) {
    Aim $Case
    Move-Away
    if (-not (Wait-ForNext $T.hit { $null = [PillWin]::SetCursorPos($script:aim.X, $script:aim.Y) })) { Fail "${Case}: the sprite's click area did not follow the cursor; see $log" }
    if (Count $T.opened) { Fail "${Case}: the pill opened before the press; see $log" }
    Press-Hold $script:aim.X $script:aim.Y $Case
}
function Open-Pill([string]$Case) {
    Aim $Case
    Move-Away
    if (-not (Wait-ForNext $T.opened { $null = [PillWin]::SetCursorPos($script:aim.X, $script:aim.Y) })) { Fail "${Case}: hovering the sprite did not open a focused pill in 3 s; see $log" }
}
function Read-Doc { [System.IO.File]::ReadAllText($doc).TrimStart([char]0xFEFF) }
# Notepad's text: Ctrl+S with our tab in front, then the file holds what is expected (or 3 s pass).
function Notepad-Holds([string]$Expected) {
    if (-not (Foreground-Is)) { return $false }
    [PillWin]::Key(0x11, $false); Press 0x53; [PillWin]::Key(0x11, $true)
    Wait-Check 3 { (Read-Doc) -ceq $Expected }
}
# Types $Word with Notepad in front and checks it landed there, not in the pill.
function Type-IntoNotepad([string]$Word, [string]$Case, [string]$Expected) {
    if (-not (Wait-Check 3 { Foreground-Is })) { Note-Keys "at $Case"; Fail "${Case}: Notepad was not in front to type into; see $focusLog" }
    [PillWin]::Text($Word)
    if (-not (Notepad-Holds $Expected)) { Note-Keys "at $Case"; Fail "${Case}: Notepad holds `"$(Read-Doc)`", not `"$Expected`"; see $focusLog" }
    if (Count (Draft-Holds $Word)) { Fail "${Case}: the pill took `"$Word`"; see $log" }
}

function Of-Type($Type) { New-Object System.Windows.Automation.PropertyCondition ($UiaEl::ControlTypeProperty), $Type }
# Read-only: every Notepad window's tab names, and our tab, wherever it is. A
# window that closes while it is read is skipped.
function Find-OurTab {
    foreach ($h in [PillWin]::Tops()) {
        $owner = Owner-Of $h
        if ((Proc-Name $owner) -ne "Notepad") { continue }
        try {
            $win = $UiaEl::FromHandle($h)
            $tabs = @($win.FindAll([System.Windows.Automation.TreeScope]::Descendants, (Of-Type ([System.Windows.Automation.ControlType]::TabItem))))
            $ours = $tabs | Where-Object { $_.Current.Name.Contains($docName) } | Select-Object -First 1
            if ($ours) { return @{ Hwnd = $h; ProcessId = $owner; Window = $win; Tab = $ours; Names = [string[]]@($tabs | ForEach-Object { $_.Current.Name }) } }
        } catch [System.Windows.Automation.ElementNotAvailableException] { "find-our-tab: window 0x$($h.ToString('x')) closed while read" | Add-Content -LiteralPath $focusLog }
    }
    $null
}
# Closes our tab by its own close button, so Notepad's session forgets it; a
# prompt about our unsaved scratch text gets Don't save. Returns "" or what failed.
function Close-OurNotepad {
    $found = Find-OurTab
    if (-not $found) { return "" }
    $plan = Get-NotepadPlan $found.Names $docName $notepadWasRunning
    if ($plan.StartsWith("fail: ")) { return $plan.Substring(6) }
    $close = $found.Tab.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (Of-Type ([System.Windows.Automation.ControlType]::Button)))
    if (-not $close) { return "our tab $docName shows no close button; close it by hand" }
    $close.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    if (-not (Wait-Check 3 { -not (Find-OurTab) })) {
        $nameIs = New-Object System.Windows.Automation.PropertyCondition ($UiaEl::NameProperty), "Don't save"
        $dont = if ([PillWin]::IsWindow($found.Hwnd)) { $found.Window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameIs) } else { $null }
        if ($dont) { $dont.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
        if (-not (Wait-Check 3 { -not (Find-OurTab) })) { return "our tab $docName is still open; close it by hand" }
    }
    if ($notepadWasRunning) { return "" }
    # This run opened Notepad: its windows go too, closed, never killed.
    $np = Get-Process -Id $found.ProcessId -ErrorAction SilentlyContinue
    if (-not $np) { return "" }
    foreach ($h in [PillWin]::Tops()) {
        if ((Owner-Of $h) -eq $found.ProcessId) { $null = [PillWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
    }
    if (-not $np.WaitForExit(3000)) { return "the Notepad this run opened (process $($found.ProcessId)) did not close in 3 s; it holds no tab of ours" }
    ""
}

$startMs = Get-NowMs
$cleanupFailed = $false
try {
    # Our window is the one showing our file: Notepad titles a window by its open
    # tab, and a new tab opens in front. The window and its process come from there.
    $null = Start-Process -FilePath notepad.exe -ArgumentList "`"$doc`""
    $found = Wait-UiaChange 0 3 { [PillWin]::Tops() | Where-Object { [PillWin]::Title($_).Contains($docName) } | Select-Object -First 1 }
    if (-not $found) { Fail "Notepad did not show $docName in 3 s" }
    $script:hwnd = [IntPtr]$found
    $script:notepad = Get-Process -Id (Owner-Of $script:hwnd)
    if ($script:notepad.ProcessName -ne "Notepad") { Fail "the $docName window belongs to $($script:notepad.ProcessName), not Notepad" }
    $ourTab = Find-OurTab
    if (-not $ourTab) { Fail "Notepad shows no tab named $docName to UI Automation" }
    $plan = Get-NotepadPlan $ourTab.Names $docName $notepadWasRunning
    if ($plan.StartsWith("fail: ")) { Fail $plan.Substring(6) }
    "notepad: process $($script:notepad.Id), tabs $($ourTab.Names.Count), was running $notepadWasRunning; cleanup will $plan" | Add-Content -LiteralPath $focusLog
    if ([PillWin]::IsIconic($script:hwnd)) { Fail "the Notepad window holding $docName is minimized; the run leaves it that way" }
    # A window already open keeps its place; one this run opened goes clear of the sprite.
    if (-not $notepadWasRunning) { $null = [PillWin]::MoveWindow($script:hwnd, 400, 250, 1400, 900, $true) }
    # Windows can refuse a background process the foreground; a click on our own tab takes it.
    $null = [PillWin]::SetForegroundWindow($script:hwnd)
    if (-not (Wait-Check 3 { Foreground-Is })) {
        $b = $ourTab.Tab.Current.BoundingRectangle
        $tabX = [int]($b.X + $b.Width / 3)
        $tabY = [int]($b.Y + $b.Height / 2)
        $under = [PillWin]::RootAt($tabX, $tabY)
        if ((Owner-Of $under) -ne $script:notepad.Id) { Fail "Notepad did not take focus, and its tab at ($tabX,$tabY) is under $(Describe-Window $under)" }
        # No Fidget yet to trace the press, so this click is down and up at once.
        $null = [PillWin]::SetCursorPos($tabX, $tabY)
        [PillWin]::Button($false); [PillWin]::Button($true)
        if (-not (Wait-Check 3 { Foreground-Is })) { Note-Keys "focusing Notepad"; Fail "Notepad did not take focus; see $focusLog" }
    }
    # A tab click leaves the keys on the tab strip; UI Automation moves them to the text.
    $text = $UiaEl::FromHandle($script:hwnd).FindFirst([System.Windows.Automation.TreeScope]::Descendants, (Of-Type ([System.Windows.Automation.ControlType]::Document)))
    if (-not $text) { Fail "Notepad shows no text area to UI Automation" }
    $text.SetFocus()
    if (-not (Wait-Check 3 { Keys-InNotepad })) { Note-Keys "focusing Notepad's text"; Fail "Notepad's text area did not take the keys; see $focusLog" }
    [PillWin]::Key(0x11, $false); Press 0x24; [PillWin]::Key(0x11, $true)

    # Fidget's private folders, set after Notepad starts so Notepad keeps the real ones.
    $null = Initialize-ScenarioData $Out @{ hide_in_fullscreen = $false }
    $q = { param($p) ($p -replace '\\', '/') }
    $harnessTag = "count=$(& $q $marks)"
    $env:FIDGET_HARNESS = "$bashPath $(& $q $root)/scripts/scenarios/fixture-harness.sh $(& $q $TestBin) script=slow $harnessTag"
    $env:FIDGET_DIRECTOR_WAKE_SECS = "600"
    $env:FIDGET_DIRECTOR_API_KEY = "x"
    $env:FIDGET_TRACE_FRAMES = "1"
    $env:FIDGET_TRACE_BUBBLE = "1"
    $env:FIDGET_TRACE_HITTEST = "1"
    $env:FIDGET_CHARACTER = "bmo"
    $env:FIDGET_CHARACTERS = $chars
    $script:proc = Start-Process -FilePath $Bin -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $Out "app.log") -RedirectStandardError (Join-Path $Out "app.err")
    if (-not (Wait-LogCount 10 $T.frame 0)) { Fail "Fidget drew no frame in 10 s; see $log" }
    if (-not (Wait-Check 10 { Test-OverlayListening (Get-Content -LiteralPath $log) })) { Fail "the overlay's webview did not report in 10 s; see $log" }
    if (-not (Wait-Check 3 { Foreground-Is })) { Note-Keys "as Fidget started"; Fail "Notepad lost focus as Fidget started; see $focusLog" }

    # 1. No pill open: a sprite click leaves Notepad in front, and typing lands there.
    Click-Sprite sprite-click
    if (-not (Foreground-Is)) { Note-Keys "after the sprite click"; Fail "sprite-click: Notepad was not in front after the click; see $focusLog" }
    Type-IntoNotepad one sprite-click oneabc
    Note-Keys "after the sprite click and one"
    Ok "sprite-click: typing stayed in Notepad"

    # 2. Hover opens the pill, Fidget traces its SetForegroundWindow, and "two" lands in the pill.
    $opens = Count $T.pillOpen
    Open-Pill hover-type
    if (-not (Wait-LogCount 3 $T.pillOpen $opens)) { Fail "hover-type: the pill opened but Fidget printed no pill open line; see $log" }
    $line = Get-Content -LiteralPath $log | Where-Object { $_ -match $T.pillOpen } | Select-Object -Last 1
    $null = $line -match $T.pillOpen
    $setResult = $Matches[2]
    $overlayAhead = if ($Matches[1] -eq $Matches[3]) { "yes" } else { "no" }
    "pill-open: SetForegroundWindow returned $setResult; the overlay is in front: $overlayAhead; line: $($line.Trim())" | Tee-Object -FilePath $results -Append | Write-Output
    Note-Keys "with the pill open"
    if (-not (Wait-ForNext $T.two { [PillWin]::Text("two") })) { Fail "hover-type: the pill never showed text=`"two`" focused=true (SetForegroundWindow returned $setResult, overlay in front: $overlayAhead); see $log" }
    Ok "hover-type: the pill took `"two`" with no click"

    # 3. Escape closes the pill.
    if (-not (Wait-ForNext $T.closed { Press 0x1B })) { Fail "escape: the pill did not close; see $log" }
    Ok "escape: the pill closed"

    # 4. A click into Notepad below its last line takes focus off the pill, and
    # typing lands at the end of Notepad's text.
    Open-Pill click-away
    $r = New-Object PillWin+RECT
    $null = [PillWin]::GetWindowRect($script:hwnd, [ref]$r)
    if (-not (Wait-ForNext $T.unfocused { Click-Notepad ([int](($r.L + $r.R) / 2)) ([int]($r.T + ($r.B - $r.T) * 7 / 10)) click-away })) {
        Fail "click-away: the pill stayed focused after the click into Notepad; see $log"
    }
    Type-IntoNotepad four click-away oneabcfour
    Ok "click-away: the click moved typing to Notepad"

    "PASS: evidence in $Out ($((Get-NowMs) - $startMs) ms)" | Tee-Object -FilePath $results -Append | Write-Output
} finally {
    Stop-FidgetTree $script:proc $harnessTag
    $script:proc = $null
    $why = Close-OurNotepad
    if ($why) {
        [Console]::Error.WriteLine("FAIL: cleanup: $why")
        "FAIL: cleanup: $why" | Add-Content -LiteralPath $results
        $cleanupFailed = $true
    }
    foreach ($d in @("webview2", "tmp", "home")) { Remove-Item -Recurse -Force -LiteralPath (Join-Path $Out $d) -ErrorAction SilentlyContinue }
}
if ($cleanupFailed) { exit 1 }
