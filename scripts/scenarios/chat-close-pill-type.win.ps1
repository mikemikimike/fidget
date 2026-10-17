#!/usr/bin/env pwsh
# Scenario: chat-close-pill-type (Windows)
# On screen: Notepad on a uniquely named scratch file, and Fidget as a standing
#   BMO with the fixture Harness. Cleanup closes only that tab (and the window
#   if this run opened Notepad), so it never comes back in Notepad's session.
# Input: SendInput cursor moves, clicks, typed words, Enter, Escape.
# Duration: about 15 s. Every wait gives up 3 s after its trigger; Fidget's
#   cold start and overlay first report get 10 s each.
# Grants: a desktop session with no Fidget running. Other Notepad tabs and
#   windows stay as they are. bash for the fixture Harness wrapper.
# Asserts: a sprite click leaves typing in Notepad; the pill opens on hover and
#   takes typing; Enter and Escape hand typing back to Notepad; a click into
#   Notepad keeps the pill's text while typing goes to the click target.
#
# Usage: chat-close-pill-type.win.ps1 --go <fidget binary> <fidget test binary>
# Without --go it prints this header, which is the takeover prompt, and exits 2.
$Go = if ($args.Count -gt 0) { $args[0] } else { "" }
$Bin = if ($args.Count -gt 1) { $args[1] } else { "" }
$TestBin = if ($args.Count -gt 2) { $args[2] } else { "" }
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
    Write-Error "usage: chat-close-pill-type.win.ps1 --go <fidget binary> <fidget test binary>"
    exit 1
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
. (Join-Path $PSScriptRoot "wait-helpers.win.ps1")
. (Join-Path $PSScriptRoot "bash-setup-win.ps1")
if (-not $bashPath) {
    [Console]::Error.WriteLine("SKIP: bash not found (tried Git Bash, then PATH)")
    exit 2
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class PillInput {
    [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT k; [FieldOffset(8)] public MOUSEINPUT m; }
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
    static void Send(INPUT i) { SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))); }
    public static void Key(ushort vk, bool up) { var i = new INPUT(); i.type = 1; i.k.vk = vk; i.k.flags = up ? 2u : 0u; Send(i); }
    public static void Char(char c) { var i = new INPUT(); i.type = 1; i.k.scan = c; i.k.flags = 4; Send(i); i.k.flags = 6; Send(i); }
    public static void Button(bool up) { var i = new INPUT(); i.type = 0; i.m.flags = up ? 4u : 2u; Send(i); }
    public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
    public static IntPtr RootAt(int x, int y) { var p = new POINT(); p.X = x; p.Y = y; return GetAncestor(WindowFromPoint(p), 2); }
}
"@
[PillInput]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null

$script:Evidence = $null
$script:proc = $null
$script:notepad = $null
$script:hwnd = [IntPtr]::Zero

function Fail([string]$Message) {
    [Console]::Error.WriteLine("FAIL: $Message")
    if ($script:Evidence) { [Console]::Error.WriteLine("evidence in $($script:Evidence)") }
    exit 1
}

# Check if Fidget already running (would share overlay)
$already = @(Get-Process -Name fidget -ErrorAction SilentlyContinue)
if ($already.Count) {
    [Console]::Error.WriteLine("SKIP: Fidget already running (pid $($already.Id -join ', '))")
    exit 2
}

$notepadWasRunning = [bool](Get-Process -Name Notepad -ErrorAction SilentlyContinue)

$TestBin = (Resolve-Path -LiteralPath $TestBin).Path
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$hex = (Get-Random -Maximum 65536).ToString('x4')
$out = Join-Path $env:TEMP "fidget-scenario-chat-close-pill-type-$stamp-$hex"
$script:Evidence = $out
$data = Initialize-ScenarioData $out @{ hide_in_fullscreen = $false }
$log = Join-Path $data "process.log"
$marks = Join-Path $out "harness.log"
Set-Content -LiteralPath $marks -Value "" -Encoding ascii

$docName = "fidget-pill-$stamp-$hex.txt"
$doc = Join-Path $out $docName
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($doc, "abc", $utf8)

# Standing BMO (no walk)
$chars = Join-Path $out "characters"
New-Item -ItemType Directory -Force -Path $chars | Out-Null
Copy-Item -Recurse (Join-Path $root "characters\bmo") $chars
$manifest = Join-Path $chars "bmo\character.manifest"
$standing = Get-Content -LiteralPath $manifest | ForEach-Object { if ($_ -match '^play = ') { $_ -replace '"walk"', '"idle"' } else { $_ } }
[System.IO.File]::WriteAllLines($manifest, [string[]]$standing, $utf8)

$q = { param($p) ($p -replace '\\', '/') }
$env:FIDGET_HARNESS = "$bashPath $(& $q $root)/scripts/scenarios/fixture-harness.sh $(& $q $TestBin) script=slow count=$(& $q $marks)"
$env:FIDGET_DIRECTOR_WAKE_SECS = "600"
$env:FIDGET_DIRECTOR_API_KEY = "x"
$env:FIDGET_TRACE_FRAMES = "1"
$env:FIDGET_TRACE_BUBBLE = "1"
$env:FIDGET_TRACE_HITTEST = "1"
$env:FIDGET_CHARACTER = "bmo"
$env:FIDGET_CHARACTERS = $chars

# Open Notepad with the unique document
$script:notepad = Start-Process -FilePath "notepad.exe" -ArgumentList $doc -PassThru
if (-not (Wait-Until 3 { 
    $tops = @([System.Diagnostics.Process]::GetProcesses() | Where-Object { $_.ProcessName -eq "Notepad" })
    foreach ($p in $tops) {
        try {
            [uint32]$pid = 0
            foreach ($h in @([PillInput]::GetForegroundWindow())) {
                [PillInput]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null
                if ($pid -eq $p.Id -and [PillInput]::Title($h) -like "*$docName*") {
                    $script:hwnd = $h
                    return $true
                }
            }
        } catch { }
    }
    $false
})) { Fail "Notepad with $docName did not open" }

# Focus Notepad's text area via UI Automation
$UiaEl = [System.Windows.Automation.AutomationElement]
$isDoc = New-Object System.Windows.Automation.PropertyCondition ($UiaEl::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Document)
$textArea = $UiaEl::FromHandle($script:hwnd).FindFirst([System.Windows.Automation.TreeScope]::Descendants, $isDoc)
if (-not $textArea) { Fail "Notepad text area not found via UI Automation" }
$textArea.SetFocus()

# Move caret to end with Ctrl+End
[PillInput]::Key(0x11, $false); [PillInput]::Key(0x23, $false)
[PillInput]::Key(0x23, $true); [PillInput]::Key(0x11, $true)
Start-Sleep -Milliseconds 100

$startMs = Get-NowMs
Write-Host "scenario: launching Fidget"
$script:proc = Start-Process -FilePath $Bin -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $out "app.log") -RedirectStandardError (Join-Path $out "app.err")

$frame = '^(?:\d+ )?frame: \d+ (\w+) pos\(\S+ sprite\((-?\d+),(-?\d+)\)'
$draft = '(?:^|\s)overlay: draft instance=\S+ chars=\d+ text="'
$hit = '(?:^|\s)overlay: click area under cursor'
$closed = '(?:^|\s)overlay: pill closed'

try {
    # Wait for first frame
    if (-not (Wait-ForTrace 10 $log $frame)) { Fail "Fidget drew no frame in 10 s" }
    
    # Wait for overlay ready (first draft report = webview listening)
    if (-not (Wait-ForTrace 10 $log "$draft`"`" focused=")) { Fail "overlay did not report ready in 10 s" }

    function Get-SpriteCenter {
        $line = Get-Content -LiteralPath $log | Where-Object { $_ -match $frame } | Select-Object -Last 1
        if ($line -match $frame) {
            $x = [int]$Matches[2]
            $y = [int]$Matches[3]
            @{ X = $x; Y = [int](($y + [int]$Matches[3]) / 2) }
        } else { $null }
    }

    function Type-Word([string]$Word) {
        foreach ($c in $Word.ToCharArray()) {
            [PillInput]::Char($c)
            Start-Sleep -Milliseconds 15
        }
    }

    function Press([uint16]$Vk) {
        [PillInput]::Key($Vk, $false)
        [PillInput]::Key($Vk, $true)
    }

    function Click-Sprite {
        $pos = Get-SpriteCenter
        if (-not $pos) { return $false }
        [PillInput]::SetCursorPos($pos.X, $pos.Y) | Out-Null
        $before = @(Get-Content -LiteralPath $log | Where-Object { $_ -match $hit }).Count
        $null = Wait-ForCount 2 $log $hit $before
        [PillInput]::Button($false)
        Start-Sleep -Milliseconds 120
        [PillInput]::Button($true)
        Start-Sleep -Milliseconds 100
        $true
    }

    function Open-Pill {
        $pos = Get-SpriteCenter
        if (-not $pos) { return $false }
        # Move away then hover
        [PillInput]::SetCursorPos($pos.X + 400, $pos.Y) | Out-Null
        Start-Sleep -Milliseconds 50
        $before = @(Get-Content -LiteralPath $log | Where-Object { $_ -match "$draft`"`" focused=true" }).Count
        [PillInput]::SetCursorPos($pos.X, $pos.Y) | Out-Null
        Wait-ForCount 3 $log "$draft`"`" focused=true" $before
    }

    function Read-Doc {
        [System.IO.File]::ReadAllText($doc, $utf8).TrimStart([char]0xFEFF)
    }

    function Foreground-Is-Notepad {
        $fg = [PillInput]::GetForegroundWindow()
        $fg -eq $script:hwnd -and [PillInput]::Title($fg) -like "*$docName*"
    }

    function Keys-InNotepad {
        try {
            $f = [System.Windows.Automation.AutomationElement]::FocusedElement
            $f.Current.ProcessId -eq $script:notepad.Id -and $f.Current.ControlType -eq ([System.Windows.Automation.ControlType]::Document)
        } catch { $false }
    }

    function Save-Doc {
        if (-not (Foreground-Is-Notepad)) { return $false }
        [PillInput]::Key(0x11, $false)
        Press 0x53
        [PillInput]::Key(0x11, $true)
        Start-Sleep -Milliseconds 200
        $true
    }

    # Test 1: Sprite click with no pill open leaves typing in Notepad
    Write-Host "test 1: sprite click leaves typing in Notepad"
    if (-not (Click-Sprite)) { Fail "test 1: could not click sprite" }
    Type-Word "four"
    if (-not (Save-Doc)) { Fail "test 1: Notepad not foreground" }
    if (-not (Wait-Until 2 { (Read-Doc) -ceq "fourabc" })) {
        Fail "test 1: Notepad holds '$(Read-Doc)', not 'fourabc'"
    }
    Write-Host "  ok: typing stayed in Notepad"

    # Test 2: Pill opens on hover and takes typing
    Write-Host "test 2: pill opens and takes typing"
    if (-not (Open-Pill)) { Fail "test 2: pill did not open" }
    $before = @(Get-Content -LiteralPath $log | Where-Object { $_ -match "$draft`"[^`"]*hello`"" }).Count
    Type-Word "hello"
    if (-not (Wait-ForCount 2 $log "$draft`"[^`"]*hello`"" $before)) {
        Fail "test 2: 'hello' never reached pill"
    }
    Write-Host "  ok: pill took typing"

    # Test 3: Enter closes pill and hands typing back to Notepad
    Write-Host "test 3: Enter closes pill"
    $before = @(Get-Content -LiteralPath $log | Where-Object { $_ -match $closed }).Count
    Press 0x0D
    if (-not (Wait-ForCount 3 $log $closed $before)) { Fail "test 3: pill did not close" }
    if (-not (Wait-Until 2 { Foreground-Is-Notepad })) { Fail "test 3: Notepad not foreground" }
    Type-Word "six"
    if (-not (Save-Doc)) { Fail "test 3: could not save" }
    if (-not (Wait-Until 2 { (Read-Doc) -ceq "foursixabc" })) {
        Fail "test 3: Notepad holds '$(Read-Doc)', not 'foursixabc'"
    }
    Write-Host "  ok: typing back in Notepad"

    # Test 4: Escape closes pill and hands typing back to Notepad
    Write-Host "test 4: Escape closes pill"
    if (-not (Open-Pill)) { Fail "test 4: pill did not open" }
    $before = @(Get-Content -LiteralPath $log | Where-Object { $_ -match "$draft`"[^`"]*seven`"" }).Count
    Type-Word "seven"
    if (-not (Wait-ForCount 2 $log "$draft`"[^`"]*seven`"" $before)) {
        Fail "test 4: 'seven' never reached pill"
    }
    $before = @(Get-Content -LiteralPath $log | Where-Object { $_ -match $closed }).Count
    Press 0x1B
    if (-not (Wait-ForCount 3 $log $closed $before)) { Fail "test 4: pill did not close" }
    if (-not (Wait-Until 2 { Foreground-Is-Notepad })) { Fail "test 4: Notepad not foreground" }
    Type-Word "eight"
    if (-not (Save-Doc)) { Fail "test 4: could not save" }
    if (-not (Wait-Until 2 { (Read-Doc) -ceq "foursixeightabc" })) {
        Fail "test 4: Notepad holds '$(Read-Doc)', not 'foursixeightabc'"
    }
    Write-Host "  ok: typing back in Notepad"

    # Test 5: Click into Notepad keeps pill's text while typing goes to Notepad
    Write-Host "test 5: click into Notepad"
    if (-not (Open-Pill)) { Fail "test 5: pill did not open" }
    $before = @(Get-Content -LiteralPath $log | Where-Object { $_ -match "$draft`"[^`"]*nine`"" }).Count
    Type-Word "nine"
    if (-not (Wait-ForCount 2 $log "$draft`"[^`"]*nine`"" $before)) {
        Fail "test 5: 'nine' never reached pill"
    }
    
    # Click into Notepad (middle lower area)
    $r = New-Object PillInput+RECT
    [PillInput]::GetWindowRect($script:hwnd, [ref]$r) | Out-Null
    $clickX = [int](($r.L + $r.R) / 2)
    $clickY = [int]($r.T + ($r.B - $r.T) * 7 / 10)
    
    # Verify click would land on Notepad
    [uint32]$pid = 0
    [PillInput]::GetWindowThreadProcessId([PillInput]::RootAt($clickX, $clickY), [ref]$pid) | Out-Null
    if ($pid -ne $script:notepad.Id) { Fail "test 5: click would not land on Notepad" }
    
    $before = @(Get-Content -LiteralPath $log | Where-Object { $_ -match "$draft`"[Nn]ine`" focused=false" }).Count
    [PillInput]::SetCursorPos($clickX, $clickY) | Out-Null
    [PillInput]::Button($false)
    Start-Sleep -Milliseconds 120
    [PillInput]::Button($true)
    
    if (-not (Wait-ForCount 2 $log "$draft`"[Nn]ine`" focused=false" $before)) {
        Fail "test 5: pill did not blur after click"
    }
    
    Type-Word "ten"
    if (-not (Save-Doc)) { Fail "test 5: could not save" }
    if (-not (Wait-Until 2 { (Read-Doc) -ceq "foursixeightabcten" })) {
        Fail "test 5: Notepad holds '$(Read-Doc)', not 'foursixeightabcten'"
    }
    Write-Host "  ok: pill kept text, typing went to Notepad"

    $elapsedMs = (Get-NowMs) - $startMs
    Write-Host "PASS: evidence in $out (${elapsedMs}ms)"

} finally {
    Stop-FidgetTree $script:proc "count=$marks"
    
    # Cleanup Notepad tab
    $UiaEl = [System.Windows.Automation.AutomationElement]
    $isTabItem = New-Object System.Windows.Automation.PropertyCondition ($UiaEl::ControlTypeProperty), ([System.Windows.Automation.ControlType]::TabItem)
    try {
        if ([PillInput]::Title($script:hwnd) -like "*$docName*") {
            $win = $UiaEl::FromHandle($script:hwnd)
            $tabs = @($win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $isTabItem))
            $ourTab = $tabs | Where-Object { $_.Current.Name -like "*$docName*" } | Select-Object -First 1
            if ($ourTab) {
                $isButton = New-Object System.Windows.Automation.PropertyCondition ($UiaEl::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Button)
                $closeBtn = $ourTab.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $isButton)
                if ($closeBtn) {
                    $closeBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                    Start-Sleep -Milliseconds 500
                    
                    # Handle "Don't save" prompt if it appears
                    $nameIs = New-Object System.Windows.Automation.PropertyCondition ($UiaEl::NameProperty), "Don't save"
                    $dontSave = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameIs)
                    if ($dontSave) {
                        $dontSave.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                    }
                }
            }
        }
        
        # If we started Notepad, close it
        if (-not $notepadWasRunning -and $script:notepad -and -not $script:notepad.HasExited) {
            $script:notepad.CloseMainWindow() | Out-Null
            if (-not $script:notepad.WaitForExit(2000)) {
                Stop-Process -Id $script:notepad.Id -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {
        # Cleanup is best-effort
    }
}
