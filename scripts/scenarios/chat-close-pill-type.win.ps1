#!/usr/bin/env pwsh
# Scenario: chat-close-pill-type (Windows)
# On screen: Notepad on a uniquely named scratch file, as a tab of a Notepad
#   already open or a window of its own, and Fidget as a standing BMO with the
#   fixture Harness. Cleanup closes only that tab (and the window if this run
#   opened Notepad), so it never comes back in Notepad's restored session.
# Input: SendInput cursor moves, held clicks, typed words, Enter, Escape, Ctrl+S.
# Duration: about 15 s. Every wait gives up 3 s after its trigger; Fidget's
#   cold start gets 10 s.
# Grants: a desktop session with no Fidget running (it skips otherwise). Other
#   Notepad tabs and windows, and any fullscreen app, stay as they are; a
#   fullscreen window is only logged. bash for the fixture Harness wrapper.
# Asserts: a sprite click leaves typing in Notepad; the pill opens on hover and
#   takes typing; Enter and Escape hand typing back to Notepad; a click into
#   Notepad keeps the pill's text while typing goes to the click.
# Set FIDGET_SCENARIO_NOTEPAD_TABS (names split by |), FIDGET_SCENARIO_DOC and
#   FIDGET_SCENARIO_NOTEPAD_BEFORE=1|0 to print the Notepad cleanup plan only.
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

# Cleanup's plan for Notepad, from its tab names: it closes only our tab, and the
# window too only when this run opened Notepad. Anything else fails loudly.
function Get-NotepadPlan([string[]]$Tabs, [string]$Ours, [bool]$WasRunning) {
    $mine = @($Tabs | Where-Object { $_ -like "*$Ours*" }).Count
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

$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
. (Join-Path $PSScriptRoot "wait-helpers.win.ps1")
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
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
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
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
    static void Send(INPUT i) { SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))); }
    public static void Key(ushort vk, bool up) { var i = new INPUT(); i.type = 1; i.k.vk = vk; i.k.flags = up ? 2u : 0u; Send(i); }
    public static void Char(char c) { var i = new INPUT(); i.type = 1; i.k.scan = c; i.k.flags = 4; Send(i); i.k.flags = 6; Send(i); }
    public static void Button(bool up) { var i = new INPUT(); i.type = 0; i.m.flags = up ? 4u : 2u; Send(i); }
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
# Per-monitor aware: cursor and window coordinates are the physical pixels Fidget traces.
[PillWin]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null

function Proc-Name([uint32]$P) { $g = Get-Process -Id $P -ErrorAction SilentlyContinue; if ($g) { $g.ProcessName } else { "?" } }
function Rect-Text($R) { "($($R.L),$($R.T))-($($R.R),$($R.B))" }
function Describe-Window([IntPtr]$H) {
    if ($H -eq [IntPtr]::Zero) { return "none" }
    [uint32]$p = 0
    [PillWin]::GetWindowThreadProcessId($H, [ref]$p) | Out-Null
    $r = New-Object PillWin+RECT
    [PillWin]::GetWindowRect($H, [ref]$r) | Out-Null
    "hwnd=0x$($H.ToString('x')) pid=$p process=$(Proc-Name $p) class=$([PillWin]::Class($H)) title=`"$([PillWin]::Title($H))`" rect=$(Rect-Text $r) monitor=$([PillWin]::Monitor($H).szDevice)"
}
function Get-Fullscreen {
    foreach ($h in [PillWin]::Tops()) {
        if ([PillWin]::Class($h) -in @("Progman", "WorkerW")) { continue }
        $r = New-Object PillWin+RECT
        [PillWin]::GetWindowRect($h, [ref]$r) | Out-Null
        $m = [PillWin]::Monitor($h).rcMonitor
        if ($r.L -le $m.L -and $r.T -le $m.T -and $r.R -ge $m.R -and $r.B -ge $m.B) { $h }
    }
}

# A Fidget already here would share the overlay.
$already = @(Get-Process -Name fidget -ErrorAction SilentlyContinue | ForEach-Object { "fidget $($_.Id)" })
if ($already.Count) {
    [Console]::Error.WriteLine("SKIP: Fidget is already running: $($already -join ', ')")
    exit 2
}
# Windows 11 Notepad is one process for every tab, so an open Notepad may hold the
# user's docs: the run adds a tab or window of its own and touches nothing else.
$notepadWasRunning = [bool](Get-Process -Name Notepad -ErrorAction SilentlyContinue)

$TestBin = (Resolve-Path -LiteralPath $TestBin).Path
if (-not $Out) { $Out = Join-Path $env:TEMP "fidget-scenario-chat-close-pill-type-$(Get-Date -Format yyyyMMdd-HHmmss)" }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
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
function Note-Foreground([string]$When) { "foreground $When`: $(Describe-Window ([PillWin]::GetForegroundWindow()))" | Add-Content -LiteralPath $focusLog }
Note-Foreground "before the run"
# Evidence only: a fullscreen app keeps running, and nothing here focuses or moves it.
$full = @(Get-Fullscreen)
foreach ($h in $full) { "fullscreen: $(Describe-Window $h)" | Add-Content -LiteralPath $focusLog }
if (-not $full.Count) { "fullscreen: none" | Add-Content -LiteralPath $focusLog }

$log = Join-Path $Out "data\process.log"
$marks = Join-Path $Out "harness.log"
Set-Content -LiteralPath $marks -Value "" -Encoding ascii
$docName = "fidget-pill-$(Get-Date -Format yyyyMMdd-HHmmss)-$((Get-Random -Maximum 65536).ToString('x4')).txt"
$doc = Join-Path $Out $docName
[System.IO.File]::WriteAllText($doc, "abc")
$chars = Join-Path $Out "characters"
New-Item -ItemType Directory -Force -Path $chars | Out-Null
Copy-Item -Recurse (Join-Path $root "characters\bmo") $chars
$manifest = Join-Path $chars "bmo\character.manifest"
$standing = Get-Content -LiteralPath $manifest | ForEach-Object { if ($_ -match '^play = ') { $_ -replace '"walk"', '"idle"' } else { $_ } }
[System.IO.File]::WriteAllLines($manifest, [string[]]$standing)
if (Select-String -LiteralPath $manifest -Pattern '^play = .*"walk"' -Quiet) { Fail "BMO still walks in $manifest" }

$frame = '(?:^|\s)frame: \d+ (?:Grounded|Perched) pos\((-?\d+),(-?\d+)\) sprite\((-?\d+),(-?\d+)\)'
$draft = '(?:^|\s)overlay: draft .*text='
$closed = '(?:^|\s)overlay: draft .* closed$'
$hit = '(?:^|\s)hit-test: cursor\(.*\bHIT\s+click-through OFF'

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
function Wait-ForNext([string]$Pattern, [scriptblock]$Trigger) {
    $before = Count $Pattern
    & $Trigger
    Wait-LogCount 3 $Pattern $before
}
# Notepad in front with our tab the open one, so keys and Ctrl+S reach only our file.
function Foreground-Is { [PillWin]::GetForegroundWindow() -eq $script:hwnd -and [PillWin]::Title($script:hwnd) -like "*$docName*" }
function Keys-InNotepad {
    try {
        $f = [System.Windows.Automation.AutomationElement]::FocusedElement
        $f.Current.ProcessId -eq $script:notepad.Id -and $f.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document
    } catch { $false }
}
function Describe-Keys {
    try {
        $f = [System.Windows.Automation.AutomationElement]::FocusedElement
        "pid=$($f.Current.ProcessId) process=$(Proc-Name $f.Current.ProcessId) type=$($f.Current.ControlType.ProgrammaticName) name=`"$($f.Current.Name)`""
    } catch { "unknown" }
}
function Note-Keys([string]$When) { Note-Foreground $When; "keys $When`: $(Describe-Keys)" | Add-Content -LiteralPath $focusLog }
function Press-Hold([int]$X, [int]$Y) {
    [PillWin]::SetCursorPos($X, $Y) | Out-Null
    # Fidget samples the buttons each frame, so the press is held past one.
    [PillWin]::Button($false); Start-Sleep -Milliseconds 120; [PillWin]::Button($true)
}
# A click only on our Notepad window, checked by the window under the point.
function Click-Notepad([int]$X, [int]$Y) {
    [uint32]$p = 0
    [PillWin]::GetWindowThreadProcessId([PillWin]::RootAt($X, $Y), [ref]$p) | Out-Null
    if ($p -ne $script:notepad.Id) { Fail "refusing to click ($X,$Y): it would land on $(Describe-Window ([PillWin]::RootAt($X, $Y)))" }
    Press-Hold $X $Y
}
# The overlay is click-through until its hit test sees the cursor, so the sprite is
# pressed once that line lands; a press 1.5 s late would meet a hover-opened pill.
function Click-Sprite([string]$Case) {
    if (-not (Wait-ForNext $hit { [PillWin]::SetCursorPos($script:cx, $script:cy) | Out-Null })) { Fail "${Case}: the sprite's click area did not follow the cursor; see $log" }
    if (Count "$draft`"`" focused=true") { Fail "${Case}: the pill opened before the press; see $log" }
    if (-not (Wait-ForNext '(?:^|\s)click: up ' { Press-Hold $script:cx $script:cy })) { Fail "${Case}: Fidget saw no click; see $log" }
}
function Type-Word([string]$Word) { foreach ($c in $Word.ToCharArray()) { [PillWin]::Char($c); Start-Sleep -Milliseconds 15 } }
function Press([uint16]$Vk) { [PillWin]::Key($Vk, $false); [PillWin]::Key($Vk, $true) }
function Sprite-Center {
    $line = Get-Content -LiteralPath $log | Where-Object { $_ -match $frame } | Select-Object -Last 1
    $null = $line -match $frame
    # pos is the feet's middle; the sprite's top is sprite().y.
    $script:cx = [int]$Matches[1]
    $script:cy = [int](([int]$Matches[4] + [int]$Matches[2]) / 2)
}
function Read-Doc { [System.IO.File]::ReadAllText($doc).TrimStart([char]0xFEFF) }
# Notepad's text: Ctrl+S, then the file holds what is expected (or 3 s pass).
function Notepad-Holds([string]$Expected) {
    if (-not (Foreground-Is)) { return $false }
    [PillWin]::Key(0x11, $false); Press 0x53; [PillWin]::Key(0x11, $true)
    Wait-Check 3 { (Read-Doc) -ceq $Expected }
}
function Open-Pill([string]$Case) {
    Sprite-Center
    [PillWin]::SetCursorPos($script:cx + 400, $script:cy) | Out-Null
    if (-not (Wait-ForNext "$draft`"`" focused=true" { [PillWin]::SetCursorPos($script:cx, $script:cy) | Out-Null })) { Fail "${Case}: the pill did not open; see $log" }
}
function Type-IntoPill([string]$Word, [string]$Case) {
    if (-not (Wait-ForNext "$draft`"[^`"]*$Word`"" { Type-Word $Word })) { Fail "${Case}: `"$Word`" never reached the pill; see $log" }
    Ok "${Case}: the pill took `"$Word`" with no click"
}
function Typing-BackInNotepad([string]$Word, [string]$Case, [string]$Expected) {
    if (-not (Wait-Check 3 { Foreground-Is })) { Note-Keys "at $Case"; Fail "${Case}: Notepad did not get focus back; see $focusLog" }
    Type-Word $Word
    if (-not (Notepad-Holds $Expected)) { Note-Keys "at $Case"; Fail "${Case}: Notepad holds `"$(Read-Doc)`", not `"$Expected`"; see $focusLog" }
    if (Count "$draft`"[^`"]*$Word`"") { Fail "${Case}: the pill took `"$Word`"; see $log" }
    Ok "${Case}: typing went back to Notepad"
}

$UiaEl = [System.Windows.Automation.AutomationElement]
function Of-Type($Type) { New-Object System.Windows.Automation.PropertyCondition ($UiaEl::ControlTypeProperty), $Type }
# Read-only: every Notepad window's tab names, and our tab, wherever it is.
function Find-OurTab {
    foreach ($h in [PillWin]::Tops()) {
        [uint32]$p = 0
        [PillWin]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
        if ((Proc-Name $p) -ne "Notepad") { continue }
        try {
            $win = $UiaEl::FromHandle($h)
            $tabs = @($win.FindAll([System.Windows.Automation.TreeScope]::Descendants, (Of-Type ([System.Windows.Automation.ControlType]::TabItem))))
            $ours = $tabs | Where-Object { $_.Current.Name -like "*$docName*" } | Select-Object -First 1
            if ($ours) { return @{ Hwnd = $h; Pid = $p; Window = $win; Tab = $ours; Names = [string[]]@($tabs | ForEach-Object { $_.Current.Name }) } }
        } catch { continue }
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
    $np = Get-Process -Id $found.Pid -ErrorAction SilentlyContinue
    if (-not $np) { return "" }
    foreach ($h in [PillWin]::Tops()) {
        [uint32]$p = 0
        [PillWin]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
        if ($p -eq $found.Pid) { $null = [PillWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
    }
    if (-not $np.WaitForExit(3000)) { return "the Notepad this run opened (pid $($found.Pid)) did not close in 3 s; it holds no tab of ours" }
    ""
}

$startMs = Get-NowMs
$cleanupFailed = $false
try {
    # Our window is the one whose title names our file: Notepad shows the open tab's name.
    $null = Start-Process -FilePath notepad.exe -ArgumentList "`"$doc`""
    $found = Wait-UiaChange 0 3 { [PillWin]::Tops() | Where-Object { [PillWin]::Title($_) -like "*$docName*" } | Select-Object -First 1 }
    if (-not $found) { Fail "Notepad did not show $docName in 3 s" }
    $script:hwnd = [IntPtr]$found
    [uint32]$npid = 0
    [PillWin]::GetWindowThreadProcessId($script:hwnd, [ref]$npid) | Out-Null
    $script:notepad = Get-Process -Id $npid
    if ($script:notepad.ProcessName -ne "Notepad") { Fail "the $docName window belongs to $($script:notepad.ProcessName), not Notepad" }
    $ourTab = Find-OurTab
    if (-not $ourTab) { Fail "Notepad shows no tab named $docName to UI Automation" }
    $plan = Get-NotepadPlan $ourTab.Names $docName $notepadWasRunning
    if ($plan.StartsWith("fail: ")) { Fail $plan.Substring(6) }
    "notepad: pid $npid, tabs $($ourTab.Names.Count), was running $notepadWasRunning; cleanup will $plan" | Add-Content -LiteralPath $focusLog
    # A window already open keeps its place; one this run opened goes clear of the sprite.
    if ([PillWin]::IsIconic($script:hwnd)) { [PillWin]::ShowWindow($script:hwnd, 9) | Out-Null }
    if (-not $notepadWasRunning) { [PillWin]::MoveWindow($script:hwnd, 400, 250, 1400, 900, $true) | Out-Null }
    # Windows can refuse a background process the foreground; a click on our own tab takes it.
    [PillWin]::SetForegroundWindow($script:hwnd) | Out-Null
    if (-not (Wait-Check 3 { Foreground-Is })) {
        $b = $ourTab.Tab.Current.BoundingRectangle
        Click-Notepad ([int]($b.X + $b.Width / 3)) ([int]($b.Y + $b.Height / 2))
        if (-not (Wait-Check 3 { Foreground-Is })) { Note-Keys "focusing Notepad"; Fail "Notepad did not take focus; see $focusLog" }
    }
    # A tab click leaves the keys on the tab strip; UI Automation moves them to the text.
    $isDoc = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Document)
    $text = [System.Windows.Automation.AutomationElement]::FromHandle($script:hwnd).FindFirst([System.Windows.Automation.TreeScope]::Descendants, $isDoc)
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
    if (-not (Wait-LogCount 10 '(?:^|\s)frame: ' 0)) { Fail "Fidget drew no frame in 10 s; see $log" }
    if (-not (Wait-LogCount 3 $frame 0)) { Fail "the Character did not land in 3 s; see $log" }
    if (-not (Wait-Check 3 { Foreground-Is })) { Note-Keys "as Fidget started"; Fail "Notepad lost focus as Fidget started; see $focusLog" }

    # 1. No pill open: a sprite click leaves typing in Notepad.
    Sprite-Center
    Click-Sprite sprite-click
    Type-Word four
    Note-Keys "after the sprite click and four"
    [PillWin]::SetCursorPos($script:cx + 400, $script:cy) | Out-Null
    if (-not (Notepad-Holds "fourabc")) { Fail "sprite-click: Notepad holds `"$(Read-Doc)`", not fourabc; see $focusLog" }
    if (Count "$draft`"[^`"]*four`"") { Fail "sprite-click: the pill took typing; see $log" }
    Ok "sprite-click: typing stayed in Notepad"

    # 2. Hover opens the pill, which takes typing; Enter sends it and hands typing back.
    Open-Pill enter
    Type-IntoPill one enter
    if (-not (Wait-ForNext $closed { Press 0x0D })) { Fail "enter: the pill did not close; see $log" }
    Typing-BackInNotepad six enter foursixabc

    # 3. Escape closes the pill and hands typing back.
    Open-Pill escape
    Type-IntoPill seven escape
    if (-not (Wait-ForNext $closed { Press 0x1B })) { Fail "escape: the pill did not close; see $log" }
    Typing-BackInNotepad eight escape foursixeightabc

    # 4. A click into Notepad below its last line keeps the pill's text, and the
    # caret moves to the end: "ten" lands there, not where the caret was.
    Open-Pill click-away
    Type-IntoPill nine click-away
    $r = New-Object PillWin+RECT
    [PillWin]::GetWindowRect($script:hwnd, [ref]$r) | Out-Null
    $mark = Count '.'
    if (-not (Wait-ForNext "$draft`"[Nn]ine`" focused=false" { Click-Notepad ([int](($r.L + $r.R) / 2)) ([int]($r.T + ($r.B - $r.T) * 7 / 10)) })) {
        Fail "click-away: the pill did not keep `"nine`" after the click; see $log"
    }
    Typing-BackInNotepad ten click-away foursixeightabcten
    if (@(Get-Content -LiteralPath $log | Where-Object { $_ -match '.' } | Select-Object -Skip $mark | Where-Object { $_ -match $closed }).Count) { Fail "click-away: the pill closed after the click; see $log" }
    Ok "click-away: the pill kept `"nine`" and typing went to the click"

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
