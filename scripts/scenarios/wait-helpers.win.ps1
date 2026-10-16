# Shared wait helpers for Windows scenario leaves.
# Dot-source this file to get Wait-ForTrace, Wait-ForMarks, Wait-ForFile,
# and Wait-ForAxDump functions that wait on actual events instead of
# fixed sleeps.

# Wait for a trace line pattern in the app log (fast timeout: 2-3s)
# Returns immediately when the pattern appears using Get-Content -Wait
function Wait-ForTrace([int]$Seconds, [string]$LogFile, [string]$Pattern) {
    if ($script:proc -and $script:proc.HasExited) { return $false }
    if (Test-Path -LiteralPath $LogFile) {
        if (Select-String -LiteralPath $LogFile -Pattern $Pattern -Quiet) {
            return $true
        }
    }
    $job = Start-Job -ScriptBlock {
        param($file, $pattern)
        Get-Content -Path $file -Wait -Tail 0 | Where-Object { $_ -match $pattern } | Select-Object -First 1
    } -ArgumentList $LogFile, $Pattern

    $result = Wait-Job -Job $job -Timeout $Seconds
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

    return $null -ne $result
}

# Wait for a marker file to contain a pattern (fast timeout: 2-3s)
# Returns immediately when the pattern appears using Get-Content -Wait
function Wait-ForMarks([int]$Seconds, [string]$MarksFile, [string]$Pattern) {
    if ($script:proc -and $script:proc.HasExited) { return $false }
    if (Test-Path -LiteralPath $MarksFile) {
        if (Select-String -LiteralPath $MarksFile -Pattern $Pattern -Quiet) {
            return $true
        }
    }
    $job = Start-Job -ScriptBlock {
        param($file, $pattern)
        Get-Content -Path $file -Wait -Tail 0 | Where-Object { $_ -match $pattern } | Select-Object -First 1
    } -ArgumentList $MarksFile, $Pattern

    $result = Wait-Job -Job $job -Timeout $Seconds
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

    return $null -ne $result
}

# Wait for a file to exist (fast timeout: 2-3s)
# Returns immediately when the file appears using FileSystemWatcher
function Wait-ForFile([int]$Seconds, [string]$FilePath) {
    if ($script:proc -and $script:proc.HasExited) { return $false }
    if (Test-Path -LiteralPath $FilePath) { return $true }

    $dir = Split-Path -Parent $FilePath
    $name = Split-Path -Leaf $FilePath

    if (-not (Test-Path -LiteralPath $dir)) {
        # Directory doesn't exist yet, poll at 200ms (no event mechanism for dir creation)
        $deadline = (Get-Date).AddSeconds($Seconds)
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $FilePath) { return $true }
            if ($script:proc -and $script:proc.HasExited) { return $false }
            Start-Sleep -Milliseconds 200
        }
        return $false
    }

    $watcher = New-Object System.IO.FileSystemWatcher
    $watcher.Path = $dir
    $watcher.Filter = $name
    $watcher.EnableRaisingEvents = $true

    try {
        $timeoutMs = $Seconds * 1000
        $result = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::Created -bor [System.IO.WatcherChangeTypes]::Renamed, $timeoutMs)
        if ($result.TimedOut) {
            return Test-Path -LiteralPath $FilePath
        }
        return $true
    } finally {
        $watcher.Dispose()
    }
}

# Wait for an accessibility dump to match a pattern (fast timeout: 2-3s)
# Polls at 200ms because AX queries are expensive and have no event mechanism
function Wait-ForAxDump([int]$Seconds, [int]$ProcessId, [string]$Title, [string]$Pattern) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        while ((Get-Date) -lt $deadline) {
            try {
                & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\ax-window-win.ps1" dump -ProcessId $ProcessId -Title $Title |
                    Out-File -FilePath $tmp -Encoding utf8 2>$null
                if ($LASTEXITCODE -eq 0) {
                    if (Select-String -LiteralPath $tmp -Pattern $Pattern -Quiet) {
                        return $true
                    }
                }
            } catch {
            }
            if ($script:proc -and $script:proc.HasExited) { return $false }
            Start-Sleep -Milliseconds 200
        }
        return $false
    } finally {
        Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
}

# Check the last frame for a state pattern
function In-State([string]$LogFile, [string]$StatePattern) {
    if (-not (Test-Path -LiteralPath $LogFile)) { return $false }
    $frame = Get-Content -LiteralPath $LogFile | Where-Object { $_ -match '^frame: ' } | Select-Object -Last 1
    if (-not $frame) { return $false }
    return $frame -match " ($StatePattern) "
}

# Milliseconds since the epoch, for the printed duration.
function Get-NowMs {
    return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

# Wait until a probe returns true, for state with no line or file to follow
# (a UI Automation dump, a window frame). Polls at 50 ms, gives up after
# $Seconds, and fails at once when Fidget has exited.
function Wait-Until([double]$Seconds, [scriptblock]$Probe) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ($true) {
        if (& $Probe) { return $true }
        if ($script:proc -and $script:proc.HasExited) { return $false }
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Milliseconds 50
    }
}

# Seed settings so the first-run tour counts as shown and never covers the
# windows a scenario reads. $HomeDir is the private HOME/USERPROFILE the
# scenario launches Fidget with.
function Set-TourShown([string]$HomeDir) {
    $dir = Join-Path $HomeDir "AppData\Roaming\fidget"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText((Join-Path $dir "settings.json"), '{"first_run_tour_shown": true}', $utf8)
}

# Cleanup for a finally block: kill Fidget and every process under it, then
# any fixture Harness whose command line holds $Pattern (bash can outlive the
# tree when its parent is already gone).
function Stop-FidgetTree($Process, [string]$Pattern) {
    if ($Process -and -not $Process.HasExited) {
        & taskkill.exe /PID $Process.Id /T /F 2>&1 | Out-Null
        if (-not $Process.HasExited) { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue }
    }
    if ($Pattern) {
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Pattern*" } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
}

# Wait until a file holds more than $Before lines matching a pattern, for a
# line that repeats (a second spawn, a second Poke). Take the count before the
# trigger.
function Wait-ForCount([double]$Seconds, [string]$FilePath, [string]$Pattern, [int]$Before) {
    return (Wait-Until $Seconds {
            (Test-Path -LiteralPath $FilePath) -and
            @(Get-Content -LiteralPath $FilePath | Where-Object { $_ -match $Pattern }).Count -gt $Before
        })
}

# The sprite's position when it is at rest, else $null: the newest Grounded
# frame in the trace, not walking or falling, in the same spot (within 2 px)
# 100 ms later. Pass it to Wait-Until to wait for the sprite to settle.
function Get-SpriteAtRest([string]$TraceFile) {
    $pattern = '^\d+\.?\d* frame: .* Grounded .* sprite\((-?\d+),(-?\d+)\) '
    function Read-Rest {
        if (-not (Test-Path -LiteralPath $TraceFile)) { return $null }
        $line = Get-Content -LiteralPath $TraceFile | Select-String -Pattern '^\d+\.?\d* frame: ' | Select-Object -Last 1
        if (-not $line -or $line.Line -match 'walk#|Falling' -or $line.Line -notmatch $pattern) { return $null }
        return @{ X = [int]$Matches[1]; Y = [int]$Matches[2] }
    }
    $first = Read-Rest
    if (-not $first) { return $null }
    Start-Sleep -Milliseconds 100
    $second = Read-Rest
    if (-not $second) { return $null }
    if ([Math]::Abs($second.X - $first.X) -le 2 -and [Math]::Abs($second.Y - $first.Y) -le 2) { return $second }
    return $null
}
