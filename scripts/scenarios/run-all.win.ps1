#!/usr/bin/env pwsh
# Scenario wrapper (Windows): runs every automated Windows leaf, one after
#   another, as one GUI takeover.
# On screen: each leaf launches its own Fidget/BMO with a fixture Harness and
#   quits it before the next starts.
# Input: the real cursor moves only where a leaf has no UI Automation route: the
#   control-click-menu right-click, the question-bubble and poke-mid-climb
#   clicks on the sprite.
#   Hands off the mouse and keyboard while it runs.
# Duration: about 2-3 min for all of them, 10 min at most.
# Isolation: TEMP and TMP point under <evidence dir> for the whole run, and each
#   leaf points FIDGET_DATA_DIR, HOME, APPDATA, LOCALAPPDATA and
#   WEBVIEW2_USER_DATA_FOLDER under its own folder there.
# Asserts: each leaf's own checks. Prints one line per leaf with its result and
#   duration, then a summary. Exit 1 if any leaf failed.
# Opt-in: landing-link-click and sign-in-button open the default browser
#   (pass --browser); pill-dual-display needs a person and two displays (pass
#   --manual). Each is added at the end.
#
# Usage: run-all.win.ps1 --go <fidget binary> <fidget test binary> <evidence dir> [--browser] [--manual]
# Without --go it prints this header, which is the takeover prompt, and exits 2.
# No param() block: Windows PowerShell binds `--go` as -Go (see question-bubble.win.ps1).
$Go = if ($args.Count -gt 0) { $args[0] } else { "" }
$Bin = if ($args.Count -gt 1) { $args[1] } else { "" }
$TestBin = if ($args.Count -gt 2) { $args[2] } else { "" }
$Evidence = if ($args.Count -gt 3) { $args[3] } else { "" }
$Manual = $args -contains "--manual"
$Browser = $args -contains "--browser"
$ErrorActionPreference = "Stop"

# Leaf name, whether it takes the test binary, and its own time limit in seconds.
$Leaves = @(
    @("thinking-row", $true, 60),
    @("chat-header-narrow", $true, 60),
    @("launcher-dies-at-startup", $true, 90),
    @("question-bubble", $true, 90),
    @("control-click-menu", $true, 90),
    @("poke-mid-climb", $false, 120)
)
$ManualLeaves = @(@("pill-dual-display", $false, 90))
# Each hands a URL to ShellExecuteW, which opens the real default browser and
# its profile outside the evidence dir.
$BrowserLeaves = @(@("landing-link-click", $false, 60), @("sign-in-button", $true, 60))

if ($Go -ne "--go") {
    $lines = Get-Content -LiteralPath $PSCommandPath
    $header = foreach ($line in $lines | Select-Object -Skip 1) {
        if (-not $line.StartsWith("#")) { break }
        $line -replace '^# ?', ''
    }
    $header -join "`n"
    exit 2
}
if (-not $Bin -or -not $TestBin -or -not $Evidence) {
    Write-Error "usage: run-all.win.ps1 --go <fidget binary> <fidget test binary> <evidence dir> [--browser] [--manual]"
    exit 1
}

$Bin = (Resolve-Path -LiteralPath $Bin).Path
$TestBin = (Resolve-Path -LiteralPath $TestBin).Path
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $Evidence "scenarios-win-$stamp"
New-Item -ItemType Directory -Force -Path (Join-Path $runDir "tmp") | Out-Null
$env:TEMP = Join-Path $runDir "tmp"
$env:TMP = $env:TEMP
. (Join-Path $PSScriptRoot "wait-helpers.win.ps1")

$todo = $Leaves
if ($Browser) { $todo += $BrowserLeaves }
if ($Manual) { $todo += $ManualLeaves }
$results = @()
$runStart = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
foreach ($leaf in $todo) {
    $name, $wantsTest, $limit = $leaf
    $leafScript = Join-Path $PSScriptRoot "$name.win.ps1"
    $leafOut = Join-Path $runDir "$name.out.txt"
    $leafErr = Join-Path $runDir "$name.err.txt"
    $argv = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $leafScript, "--go", $Bin)
    if ($wantsTest) { $argv += $TestBin }
    $start = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $p = Start-Process -FilePath "powershell.exe" -ArgumentList $argv -PassThru -NoNewWindow `
        -RedirectStandardOutput $leafOut -RedirectStandardError $leafErr
    if (-not $p.WaitForExit($limit * 1000)) {
        Stop-ScenarioTree $p $null
        $code = "timeout"
    } else {
        $code = $p.ExitCode
    }
    $ms = Get-ElapsedMs $start
    $status = switch ($code) { 0 { "PASS" } 2 { "SKIP" } default { "FAIL" } }
    $last = @(Get-Content -LiteralPath $leafOut, $leafErr -ErrorAction SilentlyContinue | Where-Object { $_ -match '^(PASS|FAIL|SKIP)' }) | Select-Object -Last 1
    $line = "{0} {1} ({2}ms) {3}" -f $status, $name, $ms, $last
    Write-Output $line
    $results += [pscustomobject]@{ Name = $name; Status = $status; Ms = $ms; Line = $line }
}
$fails = @($results | Where-Object { $_.Status -eq "FAIL" })
$passes = @($results | Where-Object { $_.Status -eq "PASS" })
$skips = @($results | Where-Object { $_.Status -eq "SKIP" })
Write-Output ("summary: {0} passed, {1} failed, {2} skipped in {3}ms; evidence in {4}" -f `
        $passes.Count, $fails.Count, $skips.Count, (Get-ElapsedMs $runStart), $runDir)
if ($fails.Count -gt 0) { exit 1 }
exit 0
