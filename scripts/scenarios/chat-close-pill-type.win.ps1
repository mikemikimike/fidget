#!/usr/bin/env pwsh
# Scenario: chat-close-pill-type (Windows)
# On screen: Notepad on a uniquely named scratch file, and Fidget as BMO with
#   the fixture Harness. Cleanup closes only that document (and the window if
#   this run opened Notepad), so it never comes back in Notepad's session.
# Input: SendInput cursor moves, clicks, typed words, and Escape.
# Duration: about 15 s. Every wait gives up after 3 s from its trigger.
# Grants: a desktop session with no Fidget running. Other Notepad tabs stay as
#   they are. bash for the fixture Harness wrapper.
# Asserts: a sprite click leaves typing in Notepad; the pill opens on hover and
#   takes typing; Escape closes the pill; a click into Notepad moves typing to
#   the click target.
#
# Usage: chat-close-pill-type.win.ps1 --go <fidget binary> <fidget test binary>
# Without --go it prints this header and exits 2.
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
$script:Evidence = $null
$script:notepadHwnd = 0

function Fail([string]$Message) {
    [Console]::Error.WriteLine("FAIL: $Message")
    if ($script:Evidence) { [Console]::Error.WriteLine("evidence in $($script:Evidence)") }
    exit 1
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PillInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public MOUSEINPUT mi;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public IntPtr dwExtraInfo;
    }
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    public static void Click(int x, int y) {
        INPUT[] inp = new INPUT[3];
        inp[0].type = 0;
        inp[0].mi.dx = x * 65535 / System.Windows.Forms.Screen.PrimaryScreen.Bounds.Width;
        inp[0].mi.dy = y * 65535 / System.Windows.Forms.Screen.PrimaryScreen.Bounds.Height;
        inp[0].mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE;
        inp[1].type = 0; inp[1].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        inp[2].type = 0; inp[2].mi.dwFlags = MOUSEEVENTF_LEFTUP;
        SendInput(3, inp, Marshal.SizeOf(typeof(INPUT)));
    }
    public static void Char(char c) {
        System.Windows.Forms.SendKeys.SendWait(c.ToString());
    }
    public static void Key(string key) {
        System.Windows.Forms.SendKeys.SendWait(key);
    }
}
'@ -ReferencedAssemblies System.Windows.Forms

$run = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$out = Join-Path $root "data/scenario-runs/chat-close-pill-type-$run"
$script:Evidence = $out
New-Item -ItemType Directory -Force -Path $out | Out-Null
$data = Initialize-ScenarioData $out @{ hide_in_fullscreen = $false }
$log = Join-Path $data "process.log"
$err = Join-Path $out "app.err"
$chars = "BMO"
$doc = Join-Path $out "note-$run.txt"

Write-Host "scenario: opening Notepad on $doc"
$script:notepadProc = Start-Process -FilePath "notepad.exe" -ArgumentList $doc -PassThru
if (-not (Wait-Until 3 {
    $tops = @([System.Diagnostics.Process]::GetProcesses() | Where-Object { $_.ProcessName -eq "Notepad" })
    foreach ($p in $tops) {
        try {
            $h = $p.MainWindowHandle
            if ($h -eq 0) { continue }
            $title = $p.MainWindowTitle
            if ($title -and $title.Contains([System.IO.Path]::GetFileName($doc))) {
                $script:notepadHwnd = $h
                return $true
            }
        } catch { }
    }
    return $false
})) {
    Fail "Notepad with $([System.IO.Path]::GetFileName($doc)) did not open in 3 s"
}

$env:FIDGET_CHARACTERS = $chars
Write-Host "scenario: launching Fidget"
$script:proc = Start-Process -FilePath $Bin -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $out "app.log") -RedirectStandardError $err

$frame = '^(?:\d+ )?frame: \d+ (\w+) pos\(\S+ sprite\((-?\d+),(-?\d+)\)'
$pillOpen = 'overlay: pill open SetForegroundWindow'
$draft = '(?:^|\d+ )overlay: draft instance=\S+ text="([^"]*)" focused=(true|false)'
$draftClosed = '(?:^|\d+ )overlay: draft instance=\S+ closed'

try {
    if (-not (Wait-ForFile 3 $log)) { Fail "process.log never appeared; see $err" }
    if (-not (Wait-Until 3 { ($script:rest = Get-SpriteAtRest $log) })) {
        Fail "sprite did not settle in 3 s; see $log"
    }

    function Type-Word([string]$Word) {
        foreach ($c in $Word.ToCharArray()) {
            [PillInput]::Char($c)
            Start-Sleep -Milliseconds 15
        }
    }

    Write-Host "test 1: sprite click leaves typing in Notepad"
    [PillInput]::Click($script:rest.X, $script:rest.Y)
    Start-Sleep -Milliseconds 100
    Type-Word "one"
    if (-not (Wait-ForUia 3 $script:notepadProc.Id {
        $fg = [PillInput]::GetForegroundWindow()
        $fg -eq $script:notepadHwnd
    })) {
        Fail "test 1: Notepad did not have foreground after sprite click"
    }
    $noteText = Get-Content -LiteralPath $doc -Raw -ErrorAction SilentlyContinue
    if (-not $noteText -or -not $noteText.Contains("one")) {
        Fail "test 1: 'one' never reached Notepad"
    }

    Write-Host "test 2: hover opens pill and takes typing"
    $hoverX = $script:rest.X
    $hoverY = $script:rest.Y - 30
    $inMove = New-Object PillInput+INPUT
    $inMove.type = 0
    $inMove.mi.dx = $hoverX * 65535 / [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
    $inMove.mi.dy = $hoverY * 65535 / [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
    $inMove.mi.dwFlags = 0x8001
    [PillInput]::SendInput(1, @($inMove), [System.Runtime.InteropServices.Marshal]::SizeOf([type][PillInput+INPUT]))
    if (-not (Wait-ForTrace 3 $log $pillOpen)) {
        Fail "test 2: pill-open trace never appeared in 3 s; see $log"
    }
    $before = @(Get-Content -LiteralPath $log | Where-Object { $_ -match $draft }).Count
    Type-Word "two"
    if (-not (Wait-ForCount 3 $log $draft $before)) {
        Fail "test 2: 'two' never reached pill"
    }

    Write-Host "test 3: Escape closes pill"
    [PillInput]::Key("{ESC}")
    if (-not (Wait-ForTrace 3 $log $draftClosed)) {
        Fail "test 3: draft closed trace never appeared; see $log"
    }

    Write-Host "test 4: click into Notepad moves typing there"
    $r = New-Object PillInput+RECT
    [PillInput]::GetWindowRect($script:notepadHwnd, [ref]$r) | Out-Null
    $clickX = [int](($r.L + $r.R) / 2)
    $clickY = [int](($r.T + $r.B) / 2)
    [uint32]$notepadPid = 0
    $rootAtClick = [PillInput]::WindowFromPoint([PillInput+POINT]@{ X = $clickX; Y = $clickY })
    [PillInput]::GetWindowThreadProcessId($rootAtClick, [ref]$notepadPid) | Out-Null
    if ($notepadPid -ne $script:notepadProc.Id) {
        Fail "test 4: click would not land on Notepad"
    }
    [PillInput]::Click($clickX, $clickY)
    if (-not (Wait-ForUia 3 $script:notepadProc.Id {
        $fg = [PillInput]::GetForegroundWindow()
        $fg -eq $script:notepadHwnd
    })) {
        Fail "test 4: Notepad did not have foreground after click"
    }
    $beforeFour = Get-Content -LiteralPath $doc -Raw -ErrorAction SilentlyContinue
    Type-Word "four"
    if (-not (Wait-Until 3 {
        $now = Get-Content -LiteralPath $doc -Raw -ErrorAction SilentlyContinue
        $now -and $now.Length -gt $beforeFour.Length -and $now.Contains("four")
    })) {
        Fail "test 4: 'four' never reached Notepad"
    }

    Write-Host "PASS"
    exit 0
} finally {
    if ($script:notepadHwnd -and $script:notepadHwnd -ne 0) {
        try {
            $h = [IntPtr]$script:notepadHwnd
            $WM_CLOSE = 0x0010
            Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam); }'
            [W]::SendMessage($h, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        } catch { }
    }
    Stop-FidgetTree $script:proc "Harness.*$chars"
    if (Test-Path -LiteralPath $doc -ErrorAction SilentlyContinue) {
        Remove-Item -LiteralPath $doc -Force -ErrorAction SilentlyContinue
    }
}
