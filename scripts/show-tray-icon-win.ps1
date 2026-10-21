#!/usr/bin/env pwsh
# Launch Fidget once and promote its tray icon out of the hidden-icons overflow,
# where a scenario's click cannot reach it. Waits on the NotifyIconSettings
# registry change, not a clock, for up to 30 s.
#
# Usage: show-tray-icon-win.ps1 <fidget.exe>
$ErrorActionPreference = "Stop"
$Bin = (Resolve-Path -LiteralPath $args[0]).Path

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class RegistryChange {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern int RegOpenKeyEx(UIntPtr key, string subKey, int options, int access, out UIntPtr result);
    [DllImport("advapi32.dll")]
    static extern int RegNotifyChangeKeyValue(UIntPtr key, bool subtree, int filter, IntPtr evt, bool async);
    static readonly UIntPtr CurrentUser = new UIntPtr(0x80000001u);
    const int KeyNotify = 0x0010;
    const int NameOrValue = 0x1 | 0x4;
    public static UIntPtr Open(string subKey) {
        UIntPtr key;
        if (RegOpenKeyEx(CurrentUser, subKey, 0, KeyNotify, out key) != 0) throw new InvalidOperationException("cannot watch HKCU\\" + subKey);
        return key;
    }
    // Arm before each check, so a change between the check and the wait still wakes it.
    public static void Arm(UIntPtr key, EventWaitHandle changed) {
        if (RegNotifyChangeKeyValue(key, true, NameOrValue, changed.SafeWaitHandle.DangerousGetHandle(), true) != 0)
            throw new InvalidOperationException("RegNotifyChangeKeyValue failed");
    }
}
"@

# The parent key, so the watch also sees NotifyIconSettings being created.
$watched = [RegistryChange]::Open("Control Panel")
$changed = New-Object System.Threading.AutoResetEvent $false
$deadline = [DateTime]::UtcNow.AddSeconds(30)
$proc = Start-Process $Bin -PassThru
try {
    while ($true) {
        [RegistryChange]::Arm($watched, $changed)
        $icon = Get-ChildItem 'HKCU:\Control Panel\NotifyIconSettings' -ErrorAction SilentlyContinue |
            Where-Object { (Get-ItemProperty $_.PSPath).ExecutablePath -eq $Bin } |
            Select-Object -First 1
        if ($icon) { break }
        $left = $deadline - [DateTime]::UtcNow
        if ($left -le [TimeSpan]::Zero -or -not $changed.WaitOne($left)) {
            Write-Error "Windows recorded no tray icon for $Bin within 30 s"
            exit 1
        }
    }
    Set-ItemProperty -Path $icon.PSPath -Name IsPromoted -Value 1 -Type DWord
    Write-Output "promoted the tray icon for $Bin"
} finally {
    & taskkill.exe /PID $proc.Id /T /F | Out-Null
}
# taskkill errs when a child is already gone; the promotion is what counts.
exit 0
