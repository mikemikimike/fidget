#!/usr/bin/env pwsh
# Self-check for wait-helpers.win.ps1's piped launch: a child's stderr lines
# land in the evidence log as written, each line wakes a waiting
# check at once, a wait gives up at its cap, and a dead child ends a wait.
# The child echoes each stdin line to stderr, so the test drives it without
# timers. Runs under pwsh 7 (any OS) and Windows PowerShell 5.1.
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "wait-helpers.win.ps1")

$failed = 0
function Check([bool]$Ok, [string]$What) {
    if ($Ok) { Write-Output "PASS: $What" } else { Write-Output "FAIL: $What"; $script:failed++ }
}

$dir = Join-Path ([System.IO.Path]::GetTempPath()) "wait-helpers-$([guid]::NewGuid().ToString('n'))"
New-Item -ItemType Directory -Path $dir | Out-Null
$script:WatchDir = $dir
$out = Join-Path $dir "app.log"
$err = Join-Path $dir "app.err"
$shell = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$echo = 'while ($null -ne ($l = [Console]::In.ReadLine())) { [Console]::Error.WriteLine($l) }'
$script:proc = Start-FidgetPiped $shell @("-NoProfile", "-Command", $echo) $out $err
try {
    $start = Get-NowMs
    $script:proc.StandardInput.WriteLine("ready")
    Check (Wait-ForTrace 3 $err '^ready$') "a line reaches the evidence log as written"
    Check (((Get-NowMs) - $start) -lt 2500) "the first line arrives well inside the cap"

    $before = @(Get-Content -LiteralPath $err | Where-Object { $_ -match '^two$' }).Count
    $start = Get-NowMs
    $script:proc.StandardInput.WriteLine("two")
    Check (Wait-ForCount 3 $err '^two$' $before) "a line written after the trigger wakes Wait-ForCount"
    $took = (Get-NowMs) - $start
    Check ($took -lt 1000) "the wake follows the line, not the cap ($took ms)"

    $start = Get-NowMs
    Check (-not (Wait-ForTrace 1 $err 'never')) "a line that never comes fails the wait"
    $took = (Get-NowMs) - $start
    Check ($took -ge 900 -and $took -lt 2000) "the wait gives up at its 1 s cap ($took ms)"

    $script:proc.StandardInput.Close()
    Check ($script:proc.WaitForExit(3000)) "the child exits once its stdin closes"
    $start = Get-NowMs
    Check (-not (Wait-ForTrace 3 $err 'never')) "a dead child fails the wait"
    Check (((Get-NowMs) - $start) -lt 1000) "a dead child fails it at once"
} finally {
    if (-not $script:proc.HasExited) { $script:proc.Kill() }
    Remove-Item -Recurse -Force -LiteralPath $dir
}
if ($failed) { Write-Output "$failed check(s) failed"; exit 1 }
Write-Output "all checks passed"
