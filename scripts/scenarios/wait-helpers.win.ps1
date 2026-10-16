# Shared wait helpers for Windows scenario leaves.
# Dot-source this file to get Wait-ForTrace, Wait-ForMarks, Wait-Until,
# Wait-ForFile, Wait-ForAxDump, Initialize-ScenarioData and Stop-ScenarioTree that wait on actual events instead of
# fixed sleeps.

# Read whatever a growing file holds, sharing it with the writer that holds it open.
function Read-Shared([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite, Delete')
        try { return (New-Object System.IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
    } catch [System.IO.IOException] {
        return $null
    }
}

# Wait until a line of the file matches (fast timeout: 2-3s). Returns the
# moment it does. A 50 ms poll in this process: Start-Job costs a second or
# more to start on Windows PowerShell, longer than the timeouts it serves, and
# its -Tail 0 missed lines written while it started.
function Wait-ForLine([double]$Seconds, [string]$File, [string]$Pattern) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $text = Read-Shared $File
        if ($null -ne $text -and ($text -split "`r?`n" | Where-Object { $_ -match $Pattern } | Select-Object -First 1)) {
            return $true
        }
        if ($script:proc -and $script:proc.HasExited) { return $false }
        Start-Sleep -Milliseconds 50
    } while ((Get-Date) -lt $deadline)
    return $false
}

# Wait for a trace line pattern in the app log (fast timeout: 2-3s)
function Wait-ForTrace([double]$Seconds, [string]$LogFile, [string]$Pattern) {
    Wait-ForLine $Seconds $LogFile $Pattern
}

# Wait for a marker file to contain a pattern (fast timeout: 2-3s)
function Wait-ForMarks([double]$Seconds, [string]$MarksFile, [string]$Pattern) {
    Wait-ForLine $Seconds $MarksFile $Pattern
}

# Wait until a probe script block returns true. Fails fast if Fidget exits.
# For state with no file to watch: a UI Automation dump, a spawn count.
function Wait-Until([double]$Seconds, [scriptblock]$Probe, [int]$StepMs = 100) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        if (& $Probe) { return $true }
        if ($script:proc -and $script:proc.HasExited) { return $false }
        Start-Sleep -Milliseconds $StepMs
    } while ((Get-Date) -lt $deadline)
    return $false
}

# Point every folder Fidget writes at under $Out, and seed settings with the
# first-run tour marked shown. On Windows a private HOME alone is not enough:
# dirs::data_dir reads the known-folder API, so FIDGET_DATA_DIR moves it.
# Returns the data folder; process.log is in it.
function Initialize-ScenarioData([string]$Out, [hashtable]$Settings = @{}) {
    $data = Join-Path $Out "data"
    $homeDir = Join-Path $Out "home"
    foreach ($d in @($data, "$homeDir\AppData\Roaming", "$homeDir\AppData\Local", "$Out\tmp", "$Out\webview2")) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
    }
    $seed = @{ first_run_tour_shown = $true }
    foreach ($k in $Settings.Keys) { $seed[$k] = $Settings[$k] }
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText((Join-Path $data "settings.json"), ($seed | ConvertTo-Json -Compress), $utf8)
    $env:FIDGET_DATA_DIR = $data
    $env:HOME = $homeDir
    $env:USERPROFILE = $homeDir
    $env:APPDATA = "$homeDir\AppData\Roaming"
    $env:LOCALAPPDATA = "$homeDir\AppData\Local"
    $env:TEMP = "$Out\tmp"
    $env:TMP = "$Out\tmp"
    $env:WEBVIEW2_USER_DATA_FOLDER = "$Out\webview2"
    return $data
}

# Kill Fidget's whole tree (WebView2 and the Harness it spawned), then any
# fixture Harness left with this run's count= file. Call from finally.
function Stop-ScenarioTree($Proc, [string]$Marks) {
    if ($Proc -and -not $Proc.HasExited) {
        & taskkill.exe /T /F /PID $Proc.Id 2>&1 | Out-Null
        if (-not $Proc.HasExited) { Stop-Process -Id $Proc.Id -Force -ErrorAction SilentlyContinue }
    }
    if ($Marks) {
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains("count=$Marks") } |
            ForEach-Object { & taskkill.exe /T /F /PID $_.ProcessId 2>&1 | Out-Null }
    }
}

# Milliseconds since $StartMs, for the duration each leaf prints.
function Get-ElapsedMs([long]$StartMs) {
    [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $StartMs
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
