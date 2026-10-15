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
        $deadline = (Get-Date).AddSeconds($Seconds)
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $FilePath) {
                return $true
            }
            if ($script:proc -and $script:proc.HasExited) {
                return $false
            }
            Start-Sleep -Milliseconds 100
        }
        return $false
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
