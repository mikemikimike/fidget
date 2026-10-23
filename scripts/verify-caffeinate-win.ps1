#!/usr/bin/env pwsh
# Scenario: caffeinate (Windows), the power requests Caffeinate takes (#1788).
#   Covers every #1788 Done-when item that `powercfg /requests` can show.
# On screen: two launches of an isolated Fidget running Beemo (bmo) and Mochi
#   (cat). The first opens Beemo's Chat and Settings, the second Beemo's Chat.
#   The script presses the cup and the Settings checkboxes through UI
#   Automation, with no mouse.
# Input: one by hand. When asked, double-click Mochi to open a second Chat.
#   With --quit-by-hand, also pick Quit in the tray menu when asked.
# Needs: an elevated PowerShell console (not the ISE), because
#   `powercfg /requests` refuses without admin rights and Ctrl+C needs a
#   console. No other Fidget may be running. Needs a debug fidget.exe: a
#   release build is a windows-subsystem exe with no console, so Ctrl+C can
#   never reach it, and the script refuses one before launching.
# Duration: about 2 min with a built exe, plus the time you take.
# Asserts, each from a `powercfg /requests` snapshot:
#   on       the cup turns it on: fidget.exe under SYSTEM and DISPLAY
#   off      the cup turns it off: under neither
#   on-again the cup turns it back on: SYSTEM and DISPLAY
#   flag-off unticking Display in Settings while on: SYSTEM only
#   flag-on  ticking Display again: SYSTEM and DISPLAY
#   second   Mochi's new Chat shows the cup pressed; still SYSTEM and DISPLAY
#   quit     after ending the process (or Quit by hand): under neither
#   ctrl-c   second launch, cup on, then Ctrl+C in the console: under neither
# Waits: on Fidget's stderr lines (Get-Content -Wait), UI Automation
#   structure events, and Wait-Process. No sleep loops.
# Isolation: FIDGET_DATA_DIR, HOME, APPDATA, LOCALAPPDATA, TEMP, TMP and
#   WEBVIEW2_USER_DATA_FOLDER all point under the evidence directory.
#
# Usage: verify-caffeinate-win.ps1 --go <evidence dir> [<fidget.exe>] [--quit-by-hand]
# Without <fidget.exe> it runs `cargo build -p fidget` (a debug build) and
# uses that exe.
# Evidence: result.txt, powercfg-<check>.txt and each launch's stderr.
# Without --go it prints this header and exits 2.
# No param() block: Windows PowerShell binds `--go` as -Go (see question-bubble.win.ps1).
$Go = if ($args.Count -gt 0) { $args[0] } else { "" }
$ErrorActionPreference = "Stop"

# The reason `caffeinate::windows::REASON` gives the power requests.
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

# The line `caffeinate::windows` prints once it turns on with exactly the
# power requests in `$Names`.
function Get-OnPattern([string]$Names) {
    '^caffeinate: on \(' + [regex]::Escape($Names) + '\)$'
}

# A Chat opening that is not the one labelled `$First`.
function Get-OtherChatPattern([string]$First) {
    '^chat: (?!' + [regex]::Escape($First) + ' is open$)\S+ is open$'
}

# The PE Subsystem field: 2 is a windows (GUI) exe, 3 a console one, 0 not a PE.
function Get-PeSubsystem([byte[]]$Bytes) {
    if ($Bytes.Length -lt 64 -or $Bytes[0] -ne 0x4D -or $Bytes[1] -ne 0x5A) { return 0 }
    $pe = [BitConverter]::ToInt32($Bytes, 0x3C)
    $field = $pe + 24 + 68
    if ($pe -lt 0 -or $field + 2 -gt $Bytes.Length) { return 0 }
    if ([BitConverter]::ToUInt32($Bytes, $pe) -ne 0x4550) { return 0 }
    [int][BitConverter]::ToUInt16($Bytes, $field)
}

# The UI Automation pattern that presses an element, from the names it
# supports. A toggle button such as the cup (`aria-pressed`) has Toggle and no
# Invoke under WebView2, so Toggle comes first. "" when it has neither.
function Get-PressPattern([string[]]$Supported) {
    $short = @($Supported | ForEach-Object { $_ -replace 'PatternIdentifiers\.Pattern$', '' })
    foreach ($name in "Toggle", "Invoke") {
        if ($short -contains $name) { return $name }
    }
    ""
}

# The result.txt lines for an error nothing else caught: the message, then
# where it was thrown.
function Get-UncaughtLines($ErrorRecord) {
    "FAIL: $($ErrorRecord.Exception.Message)"
    $ErrorRecord.ScriptStackTrace
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
Set-Content -LiteralPath $result -Value "" -Encoding ascii
$proc = $null
$stderr = $null

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
# Everything from here runs inside one try, so an error nothing else catches
# still lands in result.txt with its stack trace, and the script exits 1.
try {
    if (-not (Test-Path -LiteralPath $Bin)) { Fail "missing $Bin" }
    $stream = [System.IO.File]::OpenRead($Bin)
    try {
        $head = New-Object byte[] 4096
        $read = $stream.Read($head, 0, $head.Length)
    } finally {
        $stream.Dispose()
    }
    $subsystem = Get-PeSubsystem $head[0..($read - 1)]
    if ($subsystem -ne 3) {
        Fail "$Bin is not a console exe (PE subsystem $subsystem). The ctrl-c check needs the debug build: pass target\debug\fidget.exe, or no exe to build it."
    }

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
        [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
        [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);

        // A visible top-level window of `pid` with this exact title.
        public static IntPtr FindWindow(uint pid, string title) {
            IntPtr found = IntPtr.Zero;
            EnumWindows((h, l) => {
                uint owner; GetWindowThreadProcessId(h, out owner);
                if (owner != pid || !IsWindowVisible(h)) return true;
                var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
                if (sb.ToString() == title) { found = h; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        static AutomationElement Find(AutomationElement root, ControlType type, string name) {
            return root.FindFirst(TreeScope.Descendants, new AndCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, type),
                new PropertyCondition(AutomationElement.NameProperty, name)));
        }

        // Pages build their controls after load, and a hidden one is out of the
        // tree. The handler wakes the wait each time the page's tree changes.
        public static AutomationElement Wait(IntPtr hwnd, ControlType type, string name, int ms) {
            var root = AutomationElement.FromHandle(hwnd);
            var changed = new AutoResetEvent(false);
            StructureChangedEventHandler handler = (s, e) => changed.Set();
            Automation.AddStructureChangedEventHandler(root, TreeScope.Subtree, handler);
            try {
                var deadline = DateTime.UtcNow.AddMilliseconds(ms);
                while (true) {
                    var found = Find(root, type, name);
                    var left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                    if (found != null || left <= 0) return found;
                    changed.WaitOne(left);
                }
            } finally {
                Automation.RemoveStructureChangedEventHandler(root, handler);
            }
        }

        // The programmatic names of the patterns `element` supports. None for an
        // element the page has since redrawn away.
        public static string[] Patterns(AutomationElement element) {
            try {
                var patterns = element.GetSupportedPatterns();
                var names = new string[patterns.Length];
                for (int i = 0; i < patterns.Length; i++) names[i] = patterns[i].ProgrammaticName;
                return names;
            } catch (ElementNotAvailableException) {
                return new string[0];
            }
        }

        // Each returns false, rather than throwing, when the element lacks the
        // pattern or is gone.
        public static bool Toggle(AutomationElement element) {
            try {
                object pattern;
                if (!element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) return false;
                ((TogglePattern)pattern).Toggle();
                return true;
            } catch (ElementNotAvailableException) {
                return false;
            }
        }

        public static bool Invoke(AutomationElement element) {
            try {
                object pattern;
                if (!element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) return false;
                ((InvokePattern)pattern).Invoke();
                return true;
            } catch (ElementNotAvailableException) {
                return false;
            }
        }

        public static bool Select(AutomationElement tab) {
            try {
                object pattern;
                if (!tab.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) return false;
                ((SelectionItemPattern)pattern).Select();
                return true;
            } catch (ElementNotAvailableException) {
                return false;
            }
        }

        // The cup's aria-pressed, which WebView2 exposes as a toggle state.
        public static string ToggleState(AutomationElement element) {
            try {
                object pattern;
                if (!element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) return "none";
                return ((TogglePattern)pattern).Current.ToggleState.ToString();
            } catch (ElementNotAvailableException) {
                return "gone";
            }
        }

        // Ctrl+C to every process on this console. This process ignores it until
        // `RestoreCtrlC`, so only Fidget, which shares the console, acts on it.
        public static bool SendCtrlC() {
            if (!SetConsoleCtrlHandler(IntPtr.Zero, true)) return false;
            return GenerateConsoleCtrlEvent(0, 0);
        }

        public static void RestoreCtrlC() {
            SetConsoleCtrlHandler(IntPtr.Zero, false);
        }
    }
"@

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
    $env:FIDGET_INSTANCES = "bmo:Beemo,cat:Mochi"
    $env:FIDGET_CHARACTERS = Join-Path $root "characters"
    $env:FIDGET_OPEN_CHAT = "1"
    # Prints the "chat: ... is open" lines the waits block on.
    $env:FIDGET_TRACE_BUBBLE = "1"

    # Starts Fidget on this console, with stderr in `<name>.err`, and returns once
    # Beemo's Chat is open. -NoNewWindow shares the console so Ctrl+C reaches it.
    function Launch([string]$Name) {
        $script:stderr = Join-Path $out "$Name.err"
        Set-Content -LiteralPath $script:stderr -Value "" -Encoding ascii
        $script:proc = Start-Process -FilePath $Bin -WorkingDirectory $out -PassThru -NoNewWindow `
            -RedirectStandardOutput (Join-Path $out "$Name.log") -RedirectStandardError $script:stderr
        Add-Content -LiteralPath (Join-Path $out "run.txt") -Value "$Name pid=$($script:proc.Id)"
        $line = Wait-Line 0 60 '^chat: \S+ is open$'
        if (-not $line) { Fail "${Name}: Chat did not open; see $script:stderr" }
        $line -replace '^chat: (\S+) is open$', '$1'
    }

    # Presses what `$Find` returns, through the pattern Get-PressPattern picks.
    # Each try finds the element again: a page redraw (Settings redraws the tab
    # after every saved change) leaves an element found earlier with no
    # patterns. Fails naming the patterns it does support after the last try.
    function Press([scriptblock]$Find, [string]$What) {
        $supported = @()
        foreach ($attempt in 1..3) {
            $element = & $Find
            $supported = @([CaffeinateWin]::Patterns($element))
            $pressed = switch (Get-PressPattern $supported) {
                "Toggle" { [CaffeinateWin]::Toggle($element) }
                "Invoke" { [CaffeinateWin]::Invoke($element) }
                default { $false }
            }
            if ($pressed) { return }
            Start-Sleep -Milliseconds 500
        }
        $names = if ($supported.Count -gt 0) { $supported -join ', ' } else { "none" }
        Fail "$What supports neither Toggle nor Invoke; it supports: $names"
    }

    # The cup in the Chat titled `$Title`. The "is open" line can land before
    # the window shows, so the window gets 10 s to appear.
    function Cup([string]$Title) {
        $deadline = (Get-Date).AddSeconds(10)
        do {
            $chat = [CaffeinateWin]::FindWindow([uint32]$proc.Id, $Title)
            if ($chat -ne [IntPtr]::Zero) { break }
            Start-Sleep -Milliseconds 250
        } while ((Get-Date) -lt $deadline)
        if ($chat -eq [IntPtr]::Zero) { Fail "no Chat window titled $Title" }
        $cup = [CaffeinateWin]::Wait($chat, [System.Windows.Automation.ControlType]::Button, "Caffeinate", 30000)
        if ($null -eq $cup) { Fail "$Title's Chat has no Caffeinate button" }
        $cup
    }

    # The Settings control named `$Name`, found fresh.
    function Settings-Control([System.Windows.Automation.ControlType]$Type, [string]$Name) {
        $settings = [CaffeinateWin]::FindWindow([uint32]$proc.Id, "Settings")
        if ($settings -eq [IntPtr]::Zero) { Fail "no Settings window" }
        $found = [CaffeinateWin]::Wait($settings, $Type, $Name, 10000)
        if ($null -eq $found) { Fail "Settings has no $Name control" }
        $found
    }

    # Presses the cup in `$Title`'s Chat and waits for the note it should cause.
    function Press-Cup([string]$Title, [string]$State) {
        $skip = Line-Count
        Press { Cup $Title } "$Title's Caffeinate cup"
        if (-not (Wait-Line $skip 10 (Get-CaffeinatePattern $State))) { Fail "no 'Caffeinate $State' line; see $stderr" }
    }

    # Flips the Display checkbox and waits for Caffeinate to turn on with the
    # power requests in `$Names`.
    function Flip-Flag([string]$Names) {
        $skip = Line-Count
        Press { Settings-Control ([System.Windows.Automation.ControlType]::CheckBox) "Display" } "the Display checkbox"
        if (-not (Wait-Line $skip 10 (Get-OnPattern $Names))) { Fail "no 'caffeinate: on ($Names)' line; see $stderr" }
    }

    $before = Requests "before-launch"
    if ((Test-FidgetRequest $before "SYSTEM") -or (Test-FidgetRequest $before "DISPLAY")) {
        Fail "a Fidget power request is already listed; quit the other Fidget first"
    }

    try {
        # Launch 1: the cup, a flag change, a second Chat, then quit.
        $env:FIDGET_OPEN_SETTINGS = "1"
        $first = Launch "launch-1"
        Press-Cup "Beemo" "on"
        Expect-Requests "on" $true $true
        Press-Cup "Beemo" "off"
        Expect-Requests "off" $false $false
        Press-Cup "Beemo" "on"
        Expect-Requests "on-again" $true $true

        $settings = [CaffeinateWin]::FindWindow([uint32]$proc.Id, "Settings")
        if ($settings -eq [IntPtr]::Zero) { Fail "no Settings window" }
        $tab = [CaffeinateWin]::Wait($settings, [System.Windows.Automation.ControlType]::TabItem, "Caffeinate", 30000)
        if ($null -eq $tab) { Fail "Settings has no Caffeinate tab" }
        if (-not [CaffeinateWin]::Select($tab)) {
            Press { Settings-Control ([System.Windows.Automation.ControlType]::TabItem) "Caffeinate" } "the Caffeinate tab"
        }
        $display = [CaffeinateWin]::Wait($settings, [System.Windows.Automation.ControlType]::CheckBox, "Display", 10000)
        if ($null -eq $display) { Fail "the Caffeinate tab has no Display checkbox" }
        $disk = [CaffeinateWin]::Wait($settings, [System.Windows.Automation.ControlType]::CheckBox, "Disk", 0)
        if ($null -ne $disk) { Fail "the Caffeinate tab draws a Disk row" }
        Pass "no-disk" "the Caffeinate tab has no Disk row"
        Flip-Flag "SYSTEM"
        Expect-Requests "flag-off" $true $false
        Flip-Flag "DISPLAY, SYSTEM"
        Expect-Requests "flag-on" $true $true

        $skip = Line-Count
        Write-Output "Double-click Mochi to open a second Chat. Waiting up to 5 minutes."
        if (-not (Wait-Line $skip 300 (Get-OtherChatPattern $first))) { Fail "no second Chat opened" }
        # The new Chat draws the cup before the shell's caffeinate view sets it.
        $deadline = (Get-Date).AddSeconds(10)
        do {
            $state = [CaffeinateWin]::ToggleState((Cup "Mochi"))
            if ($state -eq "On") { break }
            Start-Sleep -Milliseconds 250
        } while ((Get-Date) -lt $deadline)
        if ($state -ne "On") { Fail "Mochi's new Chat shows the cup as $state, not pressed" }
        Pass "second-cup" "Mochi's Chat opened with the cup pressed"
        Expect-Requests "second" $true $true

        if ($QuitByHand) {
            Write-Output "Pick Quit in Fidget's tray menu now. Waiting up to 5 minutes."
            Wait-Process -Id $proc.Id -Timeout 300 -ErrorAction SilentlyContinue
            if (-not $proc.HasExited) { Fail "Fidget did not quit within 5 minutes" }
        } else {
            Stop-Process -Id $proc.Id -Force
            Wait-Process -Id $proc.Id -Timeout 30 -ErrorAction SilentlyContinue
            if (-not $proc.HasExited) { Fail "Fidget did not end" }
        }
        Expect-Requests "quit" $false $false

        # Launch 2: each launch starts off; turn it on, then Ctrl+C.
        Remove-Item Env:FIDGET_OPEN_SETTINGS
        Launch "launch-2" | Out-Null
        Expect-Requests "relaunch" $false $false
        Press-Cup "Beemo" "on"
        Expect-Requests "on-before-ctrl-c" $true $true
        try {
            if (-not [CaffeinateWin]::SendCtrlC()) { Fail "could not send Ctrl+C; run this from a console, not the ISE" }
            Wait-Process -Id $proc.Id -Timeout 30 -ErrorAction SilentlyContinue
        } finally {
            [CaffeinateWin]::RestoreCtrlC()
        }
        if (-not $proc.HasExited) { Fail "Fidget did not exit on Ctrl+C" }
        Expect-Requests "ctrl-c" $false $false

        Write-Output "PASS: every check passed; evidence in $out"
    } finally {
        if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    }
} catch {
    $lines = @(Get-UncaughtLines $_)
    Add-Content -LiteralPath $result -Value $lines
    foreach ($line in $lines) { [Console]::Error.WriteLine($line) }
    [Console]::Error.WriteLine("Evidence: $out")
    exit 1
}
