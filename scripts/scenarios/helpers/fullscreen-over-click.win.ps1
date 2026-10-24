# Shared click gate for the Windows leaves that click the sprite. A fullscreen
# window under Fidget's always-on-top overlay does not take the click.

Add-Type -AssemblyName System.Windows.Forms

$stackCode = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ClickStack {
    public delegate bool Callback(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lp, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lp, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    public const int GWL_EXSTYLE = -20;
    public const int DWMWA_CLOAKED = 14;
}
"@
if (-not ("ClickStack" -as [type])) {
    Add-Type -TypeDefinition $stackCode
}

# Visible top-level windows front to back, unfiltered; Get-FullscreenOverClick
# decides which of them could take the click.
function Get-ClickStack {
    $state = @{ Windows = [System.Collections.Generic.List[object]]::new() }
    [ClickStack]::EnumWindows({
            param($hwnd, $lParam)
            if (-not [ClickStack]::IsWindowVisible($hwnd)) { return $true }
            $rect = New-Object ClickStack+RECT
            if (-not [ClickStack]::GetWindowRect($hwnd, [ref]$rect)) { return $true }
            $cloaked = 0
            $hr = [ClickStack]::DwmGetWindowAttribute($hwnd, [ClickStack]::DWMWA_CLOAKED, [ref]$cloaked, 4)
            $ownerPid = [uint32]0
            [ClickStack]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid) | Out-Null
            $cls = New-Object System.Text.StringBuilder 256
            [ClickStack]::GetClassName($hwnd, $cls, $cls.Capacity) | Out-Null
            $title = New-Object System.Text.StringBuilder 512
            [ClickStack]::GetWindowText($hwnd, $title, $title.Capacity) | Out-Null
            $state.Windows.Add(@{
                    Pid = [int]$ownerPid; Class = $cls.ToString(); Title = $title.ToString()
                    Left = $rect.Left; Top = $rect.Top; Right = $rect.Right; Bottom = $rect.Bottom
                    ExStyle = [ClickStack]::GetWindowLong($hwnd, [ClickStack]::GWL_EXSTYLE); Cloaked = ($hr -eq 0 -and $cloaked -ne 0)
                })
            return $true
        }, [IntPtr]::Zero) | Out-Null
    return $state.Windows
}

# The fullscreen window stacked over Fidget at (X, Y), which would take the
# click, else $null. Fullscreen is within 1 px of a whole screen.
function Get-FullscreenOverClick($Windows, $Screens, [int]$X, [int]$Y, [int]$FidgetPid) {
    $clickThrough = 0x20
    $toolWindow = 0x80
    foreach ($win in $Windows) {
        if ($X -lt $win.Left -or $X -ge $win.Right -or $Y -lt $win.Top -or $Y -ge $win.Bottom) { continue }
        if ($win.Pid -eq $FidgetPid) { return $null }
        if ($win.Cloaked -or ($win.ExStyle -band $clickThrough) -ne 0) { continue }
        # Tool windows do take clicks. Skipping them is a guess that a fullscreen
        # one is a game or recording overlay, not an app the user is in.
        if (($win.ExStyle -band $toolWindow) -ne 0) { continue }
        foreach ($screen in $Screens) {
            if ([Math]::Abs($win.Left - $screen.Left) -le 1 -and [Math]::Abs($win.Top - $screen.Top) -le 1 -and
                [Math]::Abs(($win.Right - $win.Left) - $screen.Width) -le 1 -and [Math]::Abs(($win.Bottom - $win.Top) - $screen.Height) -le 1) {
                return $win
            }
        }
    }
    return $null
}

function Skip-IfFullscreenOverClick([int]$X, [int]$Y, [int]$FidgetPid, [string]$Evidence, [string]$Gesture) {
    $screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $b = $_.Bounds; @{ Left = $b.Left; Top = $b.Top; Width = $b.Width; Height = $b.Height } })
    $over = Get-FullscreenOverClick (Get-ClickStack) $screens $X $Y $FidgetPid
    if (-not $over) { return }
    Set-Content -LiteralPath (Join-Path $Evidence "preflight.txt") -Encoding utf8 -Value "Click: $X,$Y`nClass: $($over.Class)`nTitle: $($over.Title)"
    [Console]::Error.WriteLine("SKIP: fullscreen app '$($over.Title)' is over the sprite and would take the $Gesture; minimize it or move it off that display and re-run")
    [Console]::Error.WriteLine("evidence in $Evidence")
    exit 2
}
