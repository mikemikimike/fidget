# Shared wait helpers for Windows scenario leaves.
# Dot-source this file to get Wait-ForTrace, Wait-ForMarks, Wait-ForFile,
# and Wait-ForAxDump functions that wait on actual events instead of
# fixed sleeps.

# Wait for a trace line pattern in the app log (fast timeout: 2-3s)
# Returns immediately when the pattern appears
function Wait-ForTrace([int]$Seconds, [string]$LogFile, [string]$Pattern) {
    if ($script:proc -and $script:proc.HasExited) { return $false }
    if (Test-Path -LiteralPath $LogFile) {
        if (Select-String -LiteralPath $LogFile -Pattern $Pattern -Quiet) {
            return $true
        }
    }
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $LogFile) {
            if (Select-String -LiteralPath $LogFile -Pattern $Pattern -Quiet) {
                return $true
            }
        }
        if ($script:proc -and $script:proc.HasExited) { return $false }
        Start-Sleep -Milliseconds 100
    }
    return $false
}

# Wait for a marker file to contain a pattern (fast timeout: 2-3s)
# Returns immediately when the pattern appears
function Wait-ForMarks([int]$Seconds, [string]$MarksFile, [string]$Pattern) {
    if ($script:proc -and $script:proc.HasExited) { return $false }
    if (Test-Path -LiteralPath $MarksFile) {
        if (Select-String -LiteralPath $MarksFile -Pattern $Pattern -Quiet) {
            return $true
        }
    }
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $MarksFile) {
            if (Select-String -LiteralPath $MarksFile -Pattern $Pattern -Quiet) {
                return $true
            }
        }
        if ($script:proc -and $script:proc.HasExited) { return $false }
        Start-Sleep -Milliseconds 100
    }
    return $false
}

# Wait for a file to exist (fast timeout: 2-3s)
# Returns immediately when the file appears
function Wait-ForFile([int]$Seconds, [string]$FilePath) {
    if ($script:proc -and $script:proc.HasExited) { return $false }
    if (Test-Path -LiteralPath $FilePath) { return $true }
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $FilePath) { return $true }
        if ($script:proc -and $script:proc.HasExited) { return $false }
        Start-Sleep -Milliseconds 100
    }
    return $false
}

# Wait for an accessibility dump to match a pattern (fast timeout: 2-3s)
# This polls because AX dumps are expensive queries with no event mechanism
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
