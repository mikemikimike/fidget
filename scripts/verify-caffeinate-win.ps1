#!/usr/bin/env pwsh
# Scenario: caffeinate (Windows), the power requests Caffeinate takes (#1788).
#   Covers every #1788 Done-when item that `powercfg /requests` can show.
# On screen: two launches of an isolated Fidget running Beemo (bmo) and Mochi
#   (cat). The first opens Beemo's Chat and Settings, the second Beemo's Chat.
#   The script presses the cup and the Settings checkboxes through UI
#   Automation. It opens Mochi's Chat with a real double-click on Mochi
#   (SendInput), and with --quit-from-menu picks Quit from Beemo's
#   right-click menu.
# Input: none, apart from accepting UAC. The mouse pointer moves onto Mochi
#   and clicks there on its own; leave the mouse alone while it runs.
# Needs: an elevated PowerShell console (not the ISE), because
#   `powercfg /requests` refuses without admin rights and Ctrl+C needs a
#   console. No other Fidget may be running. Needs a debug fidget.exe: a
#   release build is a windows-subsystem exe with no console, so Ctrl+C can
#   never reach it, and the script refuses one before launching.
# Duration: about 2 min with a built exe.
# Asserts, each from a `powercfg /requests` snapshot:
#   on       the cup turns it on: fidget.exe under SYSTEM and DISPLAY
#   off      the cup turns it off: under neither
#   on-again the cup turns it back on: SYSTEM and DISPLAY
#   flag-off unticking Display in Settings while on: SYSTEM only
#   flag-on  ticking Display again: SYSTEM and DISPLAY
#   second   Mochi's new Chat shows the cup pressed; still SYSTEM and DISPLAY
#   quit     after ending the process (or Quit from the menu): under neither
#   ctrl-c   second launch, cup on, then Ctrl+C in the console: under neither
# Waits: on Fidget's stderr lines (read off its pipe as they land), UI
#   Automation events, and Wait-Process. No sleep loops.
# Isolation: FIDGET_DATA_DIR, HOME, APPDATA, LOCALAPPDATA, TEMP, TMP and
#   WEBVIEW2_USER_DATA_FOLDER all point under the evidence directory.
#
# Usage: verify-caffeinate-win.ps1 --go <evidence dir> [<fidget.exe>] [--quit-from-menu]
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

# A frame of Instance `$Id` (with -Except, of any other Instance) standing
# on something, so not mid-fall or held: the `frame:` line frame_loop prints
# under FIDGET_TRACE_FRAMES, which ends in the Instance id.
function Get-FramePattern([string]$Id, [switch]$Except) {
    $instance = if ($Except) { '(?!' + [regex]::Escape($Id) + '$)\S+' } else { [regex]::Escape($Id) }
    '^frame: \d+ (Grounded|Perched) pos\(-?\d+,-?\d+\) sprite\(-?\d+,-?\d+\) \S+#\d+ ' + $instance + '$'
}

# The Instance id in a Chat label: chat_label is `chat-<id>`.
function Get-ChatInstance([string]$Label) {
    $Label -replace '^chat-', ''
}

# The factor from the Engine's points to screen pixels, from the primary
# display's DPI: Fidget divides the cursor by the primary monitor's scale
# factor, which is that DPI over 96. Exact, where the `scale` in the trace
# lines is rounded to one place (125% would read 1.2).
function Get-DpiScale([int]$Dpi) {
    if ($Dpi -le 0) { return 0 }
    $Dpi / 96
}

# Whether the overlay passes clicks through ("on") or takes them ("OFF"), from
# a `hit-test:` line. "" for another line.
function Get-ClickThrough([string]$Line) {
    if ($Line -cmatch '^hit-test: .* click-through (on|OFF)(  <- flipped)?$') { $Matches[1] } else { "" }
}

# Where to click a sprite, in screen pixels, from its `frame:` line. pos() is
# the contact point at the middle of the art's bottom edge and sprite() its
# top-left (overlay::place_sprite), so halfway down at pos's x is the art's
# middle, which is drawn in every frame of the cat. "" for another line.
function Get-SpritePoint([string]$Frame, [double]$Scale) {
    if ($Frame -notmatch ' pos\((-?\d+),(-?\d+)\) sprite\((-?\d+),(-?\d+)\) ') { return "" }
    $x = [int]$Matches[1]
    $y = ([int]$Matches[2] + [int]$Matches[4]) / 2
    "$([math]::Round($x * $Scale)),$([math]::Round($y * $Scale))"
}

# The `hit-test:` line for the overlay stopping passing clicks through, which
# it does once the cursor is over drawn sprite pixels.
$HitFlipPattern = '^hit-test: .* HIT\s+click-through OFF\s+<- flipped$'
# And for it passing clicks through again, once the cursor is off them.
$MissFlipPattern = '^hit-test: .* miss\s+click-through on\s+<- flipped$'

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
$QuitFromMenu = $rest -contains "--quit-from-menu"
$positional = @($rest | Where-Object { $_ -ne "--quit-from-menu" })
if ($positional.Count -lt 1 -or $positional.Count -gt 2) {
    Write-Error "usage: verify-caffeinate-win.ps1 --go <evidence dir> [<fidget.exe>] [--quit-from-menu]"
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
$tee = $null

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

    # Blocks until a line of Fidget's stderr from line `$Skip` on matches
    # `$Pattern` (case-insensitive, as -match), or the timeout. The tee wakes it
    # as each line comes off the pipe.
    function Wait-Line([int]$Skip, [int]$Seconds, [string]$Pattern) {
        $tee.WaitLine($Skip, $Seconds * 1000, $Pattern)
    }
    function Line-Count { $tee.Count }

    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase @"
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.IO;
    using System.Text;
    using System.Text.RegularExpressions;
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
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point point, uint flags);
        [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);

        [StructLayout(LayoutKind.Sequential)]
        struct Point { public int x, y; }

        [StructLayout(LayoutKind.Sequential)]
        struct MouseInput { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
        [StructLayout(LayoutKind.Sequential)]
        struct Input { public uint type; public MouseInput mi; }

        const uint Move = 0x0001, LeftDown = 0x0002, LeftUp = 0x0004, RightDown = 0x0008, RightUp = 0x0010;
        const uint Absolute = 0x8000, VirtualDesk = 0x4000;

        // A stream of Fidget's (stderr or stdout) copied line by line to a file,
        // and kept, so a wait wakes on the line itself rather than on a re-read
        // of the file.
        public sealed class Tee {
            readonly List<string> lines = new List<string>();
            readonly object gate = new object();
            public Tee(StreamReader from, string path) {
                var to = new StreamWriter(path, false, new UTF8Encoding(false));
                to.AutoFlush = true;
                var reader = new Thread(() => {
                    try {
                        string line;
                        while ((line = from.ReadLine()) != null) {
                            to.WriteLine(line);
                            lock (gate) { lines.Add(line); Monitor.PulseAll(gate); }
                        }
                    } catch (IOException) {
                    } catch (ObjectDisposedException) {
                    } finally {
                        to.Dispose();
                    }
                });
                reader.IsBackground = true;
                reader.Start();
            }
            public int Count { get { lock (gate) return lines.Count; } }
            // The last line so far matching `pattern`, or null.
            public string Last(string pattern) {
                var re = new Regex(pattern, RegexOptions.IgnoreCase);
                lock (gate) {
                    for (var i = lines.Count - 1; i >= 0; i--) if (re.IsMatch(lines[i])) return lines[i];
                }
                return null;
            }
            // The first line from `skip` on matching `pattern`, or null at `ms`.
            public string WaitLine(int skip, int ms, string pattern) {
                var re = new Regex(pattern, RegexOptions.IgnoreCase);
                var deadline = DateTime.UtcNow.AddMilliseconds(ms);
                lock (gate) {
                    for (var i = skip; ; ) {
                        for (; i < lines.Count; i++) if (re.IsMatch(lines[i])) return lines[i];
                        var left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                        if (left <= 0) return null;
                        Monitor.Wait(gate, left);
                    }
                }
            }
        }

        static Input Mouse(uint flags, int dx, int dy) {
            var input = new Input();
            input.type = 0;
            input.mi.dx = dx; input.mi.dy = dy; input.mi.flags = flags;
            return input;
        }

        // Sends `inputs` as real input, measured in physical pixels whatever
        // this PowerShell's DPI awareness. True when Windows took all of them.
        static bool Send(params Input[] inputs) {
            return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) == inputs.Length;
        }

        // Runs `body` per-monitor aware (v2) on this thread, so metrics, DPI and
        // pointer moves are in physical pixels, as Fidget (per-monitor aware)
        // reads them, whatever this PowerShell's own awareness.
        static T InPixels<T>(Func<T> body) {
            var before = IntPtr.Zero;
            try { before = SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
            try {
                return body();
            } finally {
                if (before != IntPtr.Zero) SetThreadDpiAwarenessContext(before);
            }
        }

        // The primary display's effective DPI, the one its scale factor comes
        // from (96 is 100%). 0 when Windows will not say.
        public static int PrimaryDpi() {
            return InPixels(() => {
                // (0,0) is on the primary display; 1 is MONITOR_DEFAULTTOPRIMARY.
                var monitor = MonitorFromPoint(new Point(), 1);
                uint x, y;
                try {
                    if (GetDpiForMonitor(monitor, 0, out x, out y) != 0) return 0;
                } catch (DllNotFoundException) { return 0; } catch (EntryPointNotFoundException) { return 0; }
                return (int)x;
            });
        }

        // Moves the pointer to (`x`, `y`) in screen pixels.
        public static bool MoveTo(int x, int y) {
            return InPixels(() => {
                int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
                int width = Math.Max(2, GetSystemMetrics(78)), height = Math.Max(2, GetSystemMetrics(79));
                var nx = (int)((long)(x - left) * 65535 / (width - 1));
                var ny = (int)((long)(y - top) * 65535 / (height - 1));
                return Send(Mouse(Move | Absolute | VirtualDesk, nx, ny));
            });
        }

        // Moves the pointer to corner `n` (0 to 3: top-left, top-right,
        // bottom-right, bottom-left) of the whole desktop, a few pixels in.
        public static bool MoveToCorner(int n) {
            var corner = InPixels(() => {
                int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
                int right = left + GetSystemMetrics(78) - 4, bottom = top + GetSystemMetrics(79) - 4;
                return new[] { new[] { left + 3, top + 3 }, new[] { right, top + 3 }, new[] { right, bottom }, new[] { left + 3, bottom } }[n % 4];
            });
            return MoveTo(corner[0], corner[1]);
        }

        // `clicks` left clicks where the pointer is. Fidget reads the button
        // once a tick, so each edge waits for the `click:` line that shows the
        // tick saw it, and the presses stay apart. Null when all landed within
        // the system double-click time, else what went wrong.
        public static string LeftClicks(Tee tee, int clicks) {
            var limit = GetDoubleClickTime();
            var clock = Stopwatch.StartNew();
            for (var n = 1; n <= clicks; n++) {
                foreach (var down in new[] { true, false }) {
                    var edge = down ? "down" : "up";
                    var skip = tee.Count;
                    if (!Send(Mouse(down ? LeftDown : LeftUp, 0, 0))) return "SendInput refused left button " + edge + " " + n;
                    if (tee.WaitLine(skip, 2000, "^click: " + edge + " ") == null) return "Fidget never saw left button " + edge + " " + n;
                }
            }
            if (clock.ElapsedMilliseconds >= limit) return "the clicks took " + clock.ElapsedMilliseconds + " ms, past the " + limit + " ms double-click time";
            return null;
        }

        // One right click where the pointer is. The overlay latches a press
        // between ticks, so the button need not stay down for one.
        public static bool RightClick() {
            return Send(Mouse(RightDown, 0, 0), Mouse(RightUp, 0, 0));
        }

        // Popup menus of process `pid` opening, from construction on, so a
        // menu that opens before `Item` is called is not missed.
        public sealed class MenuWatch : IDisposable {
            readonly AutoResetEvent opened = new AutoResetEvent(false);
            readonly AutomationEventHandler handler;
            AutomationElement menu;
            public MenuWatch(int pid) {
                handler = (s, e) => {
                    var element = s as AutomationElement;
                    try {
                        if (element != null && element.Current.ProcessId == pid) { menu = element; opened.Set(); }
                    } catch (ElementNotAvailableException) { }
                };
                Automation.AddAutomationEventHandler(AutomationElement.MenuOpenedEvent, AutomationElement.RootElement, TreeScope.Subtree, handler);
            }
            // The item whose name starts with `prefix` in the menu that opened,
            // or null when none opened within `ms` or it has no such item.
            public AutomationElement Item(string prefix, int ms) {
                if (!opened.WaitOne(ms)) return null;
                try {
                    var items = menu.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem));
                    foreach (AutomationElement item in items) {
                        if (item.Current.Name.StartsWith(prefix)) return item;
                    }
                } catch (ElementNotAvailableException) { }
                return null;
            }
            public void Dispose() {
                Automation.RemoveAutomationEventHandler(AutomationElement.MenuOpenedEvent, AutomationElement.RootElement, handler);
            }
        }

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

        // Waits for `FindWindow` to see the window, waking when any window opens
        // or focus moves (a new window takes focus as it shows).
        public static IntPtr WaitWindow(uint pid, string title, int ms) {
            var changed = new AutoResetEvent(false);
            AutomationEventHandler opened = (s, e) => changed.Set();
            AutomationFocusChangedEventHandler focused = (s, e) => changed.Set();
            Automation.AddAutomationEventHandler(WindowPattern.WindowOpenedEvent, AutomationElement.RootElement, TreeScope.Subtree, opened);
            Automation.AddAutomationFocusChangedEventHandler(focused);
            try {
                var deadline = DateTime.UtcNow.AddMilliseconds(ms);
                while (true) {
                    var found = FindWindow(pid, title);
                    var left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                    if (found != IntPtr.Zero || left <= 0) return found;
                    changed.WaitOne(left);
                }
            } finally {
                Automation.RemoveAutomationEventHandler(WindowPattern.WindowOpenedEvent, AutomationElement.RootElement, opened);
                Automation.RemoveAutomationFocusChangedEventHandler(focused);
            }
        }

        // Waits for `element`'s toggle state to read `state`, waking on each
        // change to it. Returns the last state read.
        public static string WaitToggleState(AutomationElement element, string state, int ms) {
            var changed = new AutoResetEvent(false);
            AutomationPropertyChangedEventHandler handler = (s, e) => changed.Set();
            Automation.AddAutomationPropertyChangedEventHandler(element, TreeScope.Element, handler, TogglePattern.ToggleStateProperty);
            try {
                var deadline = DateTime.UtcNow.AddMilliseconds(ms);
                while (true) {
                    var now = ToggleState(element);
                    var left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                    if (now == state || now == "gone" || left <= 0) return now;
                    changed.WaitOne(left);
                }
            } finally {
                try { Automation.RemoveAutomationPropertyChangedEventHandler(element, handler); } catch (ElementNotAvailableException) { }
            }
        }

        // Structure changes under a window, counted from construction, so a
        // change between a find and the wait for the next one is not missed.
        public sealed class StructureWatch : IDisposable {
            readonly AutomationElement root;
            readonly AutoResetEvent changed = new AutoResetEvent(false);
            readonly StructureChangedEventHandler handler;
            public StructureWatch(IntPtr hwnd) {
                root = AutomationElement.FromHandle(hwnd);
                handler = (s, e) => changed.Set();
                Automation.AddStructureChangedEventHandler(root, TreeScope.Subtree, handler);
            }
            // True once the tree has changed since the last call, false at `ms`.
            public bool Next(int ms) { return changed.WaitOne(ms); }
            public void Dispose() {
                try { Automation.RemoveStructureChangedEventHandler(root, handler); } catch (ElementNotAvailableException) { }
            }
        }

        public static StructureWatch WatchStructure(IntPtr hwnd) { return new StructureWatch(hwnd); }

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

        // The pattern of `element`, or null when it lacks it or is gone.
        static object Pattern(AutomationElement element, AutomationPattern which) {
            try {
                object pattern;
                return element.TryGetCurrentPattern(which, out pattern) ? pattern : null;
            } catch (ElementNotAvailableException) {
                return null;
            }
        }

        // Each returns false, rather than throwing, when the element lacks the
        // pattern or is gone. Once the pattern call is made the press counts:
        // the page can redraw the element away before the call returns, and
        // pressing again would flip it back.
        public static bool Toggle(AutomationElement element) {
            var pattern = (TogglePattern)Pattern(element, TogglePattern.Pattern);
            if (pattern == null) return false;
            try { pattern.Toggle(); } catch (ElementNotAvailableException) { }
            return true;
        }

        public static bool Invoke(AutomationElement element) {
            var pattern = (InvokePattern)Pattern(element, InvokePattern.Pattern);
            if (pattern == null) return false;
            try { pattern.Invoke(); } catch (ElementNotAvailableException) { }
            return true;
        }

        public static bool Select(AutomationElement tab) {
            var pattern = (SelectionItemPattern)Pattern(tab, SelectionItemPattern.Pattern);
            if (pattern == null) return false;
            try { pattern.Select(); } catch (ElementNotAvailableException) { }
            return true;
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
    # Print each sprite's place every frame, the overlay's click-through flips
    # and each left button edge: what aiming at Mochi and clicking it wait on.
    $env:FIDGET_TRACE_FRAMES = "1"
    $env:FIDGET_TRACE_HITTEST = "1"

    # Starts Fidget on this console, with stderr teed to `<name>.err`, and
    # returns once Beemo's Chat is open. No new window, so it shares the
    # console and Ctrl+C reaches it.
    function Launch([string]$Name) {
        $script:stderr = Join-Path $out "$Name.err"
        $start = New-Object System.Diagnostics.ProcessStartInfo $Bin
        $start.WorkingDirectory = $out
        $start.UseShellExecute = $false
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.StandardOutputEncoding = $utf8
        $start.StandardErrorEncoding = $utf8
        $script:proc = [System.Diagnostics.Process]::Start($start)
        $script:tee = New-Object 'CaffeinateWin+Tee' -ArgumentList $script:proc.StandardError, $script:stderr
        New-Object 'CaffeinateWin+Tee' -ArgumentList $script:proc.StandardOutput, (Join-Path $out "$Name.log") | Out-Null
        Add-Content -LiteralPath (Join-Path $out "run.txt") -Value "$Name pid=$($script:proc.Id)"
        $line = Wait-Line 0 60 '^chat: \S+ is open$'
        if (-not $line) { Fail "${Name}: Chat did not open; see $script:stderr" }
        $line -replace '^chat: (\S+) is open$', '$1'
    }

    # Presses what `$Find` returns in `$Window`, through the pattern
    # Get-PressPattern picks. A page redraw (Settings redraws the tab after
    # every saved change) leaves an element found earlier with no patterns, so
    # each of up to 3 tries finds it again, the next after the window's tree
    # changes. Fails naming the patterns it does support after the last try.
    function Press([IntPtr]$Window, [scriptblock]$Find, [string]$What) {
        $supported = @()
        $watch = [CaffeinateWin]::WatchStructure($Window)
        try {
            foreach ($attempt in 1..3) {
                $element = & $Find
                $supported = @([CaffeinateWin]::Patterns($element))
                $pressed = switch (Get-PressPattern $supported) {
                    "Toggle" { [CaffeinateWin]::Toggle($element) }
                    "Invoke" { [CaffeinateWin]::Invoke($element) }
                    default { $false }
                }
                if ($pressed) { return }
                if (-not $watch.Next(5000)) { break }
            }
        } finally {
            $watch.Dispose()
        }
        $names = if ($supported.Count -gt 0) { $supported -join ', ' } else { "none" }
        Fail "$What supports neither Toggle nor Invoke; it supports: $names"
    }

    # The Chat window titled `$Title`. The "is open" line can land before the
    # window shows, so this waits up to 10 s for it to open.
    function Chat([string]$Title) {
        $chat = [CaffeinateWin]::WaitWindow([uint32]$proc.Id, $Title, 10000)
        if ($chat -eq [IntPtr]::Zero) { Fail "no Chat window titled $Title" }
        $chat
    }

    # The cup in the Chat window `$Window` titled `$Title`, found fresh.
    function Cup([string]$Title, [IntPtr]$Window = [IntPtr]::Zero) {
        if ($Window -eq [IntPtr]::Zero) { $Window = Chat $Title }
        $cup = [CaffeinateWin]::Wait($Window, [System.Windows.Automation.ControlType]::Button, "Caffeinate", 30000)
        if ($null -eq $cup) { Fail "$Title's Chat has no Caffeinate button" }
        $cup
    }

    function Settings-Window {
        $settings = [CaffeinateWin]::WaitWindow([uint32]$proc.Id, "Settings", 10000)
        if ($settings -eq [IntPtr]::Zero) { Fail "no Settings window" }
        $settings
    }

    # The Settings control named `$Name`, found fresh.
    function Settings-Control([IntPtr]$Window, [System.Windows.Automation.ControlType]$Type, [string]$Name) {
        $found = [CaffeinateWin]::Wait($Window, $Type, $Name, 10000)
        if ($null -eq $found) { Fail "Settings has no $Name control" }
        $found
    }

    # Presses the cup in `$Title`'s Chat and waits for the note it should cause.
    function Press-Cup([string]$Title, [string]$State) {
        $skip = Line-Count
        $chat = Chat $Title
        Press $chat { Cup $Title $chat } "$Title's Caffeinate cup"
        if (-not (Wait-Line $skip 10 (Get-CaffeinatePattern $State))) { Fail "no 'Caffeinate $State' line; see $stderr" }
    }

    # Flips the Display checkbox and waits for Caffeinate to turn on with the
    # power requests in `$Names`.
    function Flip-Flag([string]$Names) {
        $skip = Line-Count
        $settings = Settings-Window
        Press $settings { Settings-Control $settings ([System.Windows.Automation.ControlType]::CheckBox) "Display" } "the Display checkbox"
        if (-not (Wait-Line $skip 10 (Get-OnPattern $Names))) { Fail "no 'caffeinate: on ($Names)' line; see $stderr" }
    }

    # Takes the pointer off every sprite. While it is on one the overlay takes
    # clicks (click-through OFF), and a move straight onto another sprite logs
    # no flip for Aim to wait on, so Aim starts from click-through on. Tries
    # each corner of the desktop in turn, since a sprite can sit in one.
    function Leave-Sprites {
        if ((Get-ClickThrough $tee.Last('^hit-test: ')) -cne "OFF") { return }
        foreach ($corner in 0..3) {
            $skip = Line-Count
            if (-not [CaffeinateWin]::MoveToCorner($corner)) { Fail "SendInput refused to move the pointer" }
            if (Wait-Line $skip 2 $MissFlipPattern) { return }
        }
        Fail "the pointer could not get off the sprites; see $stderr"
    }

    # Puts the pointer on the sprite of `$What`, aimed from its next frame
    # line matching `$Frame`, and returns once the overlay stops passing
    # clicks through there. A sprite can walk off before the pointer lands
    # (Mochi shies away from a pointer that jumps at it), so it aims up to 3
    # times.
    function Aim([string]$Frame, [string]$What) {
        $dpi = [CaffeinateWin]::PrimaryDpi()
        $scale = Get-DpiScale $dpi
        if ($scale -le 0) { Fail "Windows gave no DPI for the primary display" }
        foreach ($attempt in 1..3) {
            Leave-Sprites
            $line = Wait-Line (Line-Count) 10 $Frame
            if (-not $line) { Fail "no standing 'frame:' line for $What; see $stderr" }
            $point = (Get-SpritePoint $line $scale) -split ','
            $skip = Line-Count
            if (-not [CaffeinateWin]::MoveTo([int]$point[0], [int]$point[1])) { Fail "SendInput refused to move the pointer" }
            if (Wait-Line $skip 2 $HitFlipPattern) { return }
        }
        Fail "the pointer never came to rest on $What; see $stderr"
    }

    # Opens the sprite menu of `$What` (frames matching `$Frame`) with a real
    # right click and picks the item whose name starts with `$Item`.
    function Sprite-Menu([string]$Frame, [string]$What, [string]$Item) {
        $watch = New-Object 'CaffeinateWin+MenuWatch' -ArgumentList $proc.Id
        try {
            Aim $Frame $What
            if (-not [CaffeinateWin]::RightClick()) { Fail "SendInput refused the right click" }
            $found = $watch.Item($Item, 10000)
        } finally {
            $watch.Dispose()
        }
        if ($null -eq $found) { Fail "the sprite menu of $What did not open with a $Item item" }
        if (-not [CaffeinateWin]::Invoke($found)) { Fail "the $Item item of $What's menu cannot be invoked" }
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

        $settings = Settings-Window
        $tab = [CaffeinateWin]::Wait($settings, [System.Windows.Automation.ControlType]::TabItem, "Caffeinate", 30000)
        if ($null -eq $tab) { Fail "Settings has no Caffeinate tab" }
        if (-not [CaffeinateWin]::Select($tab)) {
            Press $settings { Settings-Control $settings ([System.Windows.Automation.ControlType]::TabItem) "Caffeinate" } "the Caffeinate tab"
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

        # A real double-click on Mochi, the gesture that Summons its Chat. Beemo
        # owns the first Chat, so Mochi is the other Instance.
        $beemo = Get-ChatInstance $first
        $skip = Line-Count
        Aim (Get-FramePattern $beemo -Except) "Mochi"
        $missed = [CaffeinateWin]::LeftClicks($tee, 2)
        if ($missed) { Fail "double-click on Mochi: $missed; see $stderr" }
        if (-not (Wait-Line $skip 10 '^verbs: \S+ .*\bSummon\b')) { Fail "the double-click did not Summon Mochi; see $stderr" }
        if (-not (Wait-Line $skip 10 (Get-OtherChatPattern $first))) { Fail "no second Chat opened" }
        # The new Chat draws the cup before the shell's caffeinate view sets it.
        $state = [CaffeinateWin]::WaitToggleState((Cup "Mochi"), "On", 10000)
        if ($state -ne "On") { Fail "Mochi's new Chat shows the cup as $state, not pressed" }
        Pass "second-cup" "Mochi's Chat opened with the cup pressed"
        Expect-Requests "second" $true $true

        if ($QuitFromMenu) {
            Sprite-Menu (Get-FramePattern $beemo) "Beemo" "Quit"
            Wait-Process -Id $proc.Id -Timeout 30 -ErrorAction SilentlyContinue
            if (-not $proc.HasExited) { Fail "Fidget did not quit from its menu" }
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
