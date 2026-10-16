# Shared wait helpers for Windows scenario leaves. File waits block on
# FileSystemWatcher events, UI waits on UI Automation events; each re-checks
# on a change and gives up after its seconds (2-3 s). Nothing sleeps.

. (Join-Path $PSScriptRoot "..\uia-signal-win.ps1")

# Milliseconds since the epoch, for the printed duration.
function Get-NowMs {
    return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

# Point every folder Fidget writes under $Out (FIDGET_DATA_DIR too, as a private
# HOME does not move dirs::data_dir) and mark the first-run tour shown.
# Returns the data folder, which holds process.log.
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
    $script:WatchDir = $Out
    return $data
}

# Block until $Test returns true, running it now and again after each change
# the OS reports under $Dir, or until $Seconds run out. A dead Fidget fails
# at its next change or at the deadline.
function Wait-OnChanges([double]$Seconds, [string]$Dir, [scriptblock]$Test) {
    if (& $Test) { return $true }
    if ($script:proc -and $script:proc.HasExited) { return $false }
    if (-not $Dir) { $Dir = $script:WatchDir }
    if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { $Dir = [System.IO.Path]::GetTempPath() }
    $watcher = New-Object System.IO.FileSystemWatcher $Dir
    $watcher.IncludeSubdirectories = $true
    $watcher.NotifyFilter = [System.IO.NotifyFilters]'FileName, DirectoryName, Size, LastWrite'
    $deadline = (Get-Date).AddSeconds($Seconds)
    try {
        while ($true) {
            $left = [int]($deadline - (Get-Date)).TotalMilliseconds
            if ($left -le 0) { return [bool](& $Test) }
            $change = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::All, $left)
            if (& $Test) { return $true }
            if ($script:proc -and $script:proc.HasExited) { return $false }
            if ($change.TimedOut) { return $false }
        }
    } finally {
        $watcher.Dispose()
    }
}

function Test-FileMatches([string]$FilePath, [string]$Pattern) {
    (Test-Path -LiteralPath $FilePath) -and [bool](Select-String -LiteralPath $FilePath -Pattern $Pattern -Quiet)
}

# Wait for a line matching a pattern to land in a file.
function Wait-ForLine([double]$Seconds, [string]$FilePath, [string]$Pattern) {
    return (Wait-OnChanges $Seconds (Split-Path -Parent $FilePath) { Test-FileMatches $FilePath $Pattern })
}

# Wait for a trace line in the app log or process.log.
function Wait-ForTrace([double]$Seconds, [string]$LogFile, [string]$Pattern) {
    return (Wait-ForLine $Seconds $LogFile $Pattern)
}

# Wait for a line in the fixture Harness marks file.
function Wait-ForMarks([double]$Seconds, [string]$MarksFile, [string]$Pattern) {
    return (Wait-ForLine $Seconds $MarksFile $Pattern)
}

# Wait for a file to exist.
function Wait-ForFile([double]$Seconds, [string]$FilePath) {
    $dir = Split-Path -Parent $FilePath
    while ($dir -and -not (Test-Path -LiteralPath $dir)) { $dir = Split-Path -Parent $dir }
    return (Wait-OnChanges $Seconds $dir { Test-Path -LiteralPath $FilePath })
}

# Wait until a file holds more than $Before lines matching a pattern, for a
# line that repeats (a second spawn, a second Poke). Take the count before the
# trigger.
function Wait-ForCount([double]$Seconds, [string]$FilePath, [string]$Pattern, [int]$Before) {
    return (Wait-OnChanges $Seconds (Split-Path -Parent $FilePath) {
            (Test-Path -LiteralPath $FilePath) -and
            @(Get-Content -LiteralPath $FilePath | Where-Object { $_ -match $Pattern }).Count -gt $Before
        })
}

# Wait until a probe returns true, for state with no file of its own (a UI
# Automation dump, a window frame). The probe runs now and again after each
# change under the scenario folder, where Fidget's trace grows as it draws.
function Wait-Until([double]$Seconds, [scriptblock]$Probe) {
    return (Wait-OnChanges $Seconds $script:WatchDir $Probe)
}

# Run ax-window-win.ps1 in this session (no new powershell per check) with
# the args a command line would take, writing its output to $OutFile.
# True when it exits 0.
function Invoke-AxWin([string]$OutFile, [string[]]$AxArgs) {
    $named = @{}
    $positional = @()
    for ($i = 0; $i -lt $AxArgs.Count; $i++) {
        if ($AxArgs[$i] -match '^-([A-Za-z]\w*)$') { $named[$Matches[1]] = $AxArgs[$i + 1]; $i++ } else { $positional += $AxArgs[$i] }
    }
    $global:LASTEXITCODE = 0
    try {
        & (Join-Path $PSScriptRoot "..\ax-window-win.ps1") @positional @named 2>&1 |
            Out-File -FilePath $OutFile -Encoding utf8
    } catch {
        $_ | Out-File -FilePath $OutFile -Encoding utf8 -Append
        return $false
    }
    return ($LASTEXITCODE -eq 0)
}

# Run a UI Automation check now and again on each UIA change event from
# the process until it returns true or the seconds run out.
function Wait-ForUia([double]$Seconds, [int]$ProcessId, [scriptblock]$Check) {
    return [bool](Wait-UiaChange $ProcessId $Seconds $Check)
}

# Wait for a UI Automation dump of a window to match a pattern.
function Wait-ForAxDump([double]$Seconds, [int]$ProcessId, [string]$Title, [string]$Pattern) {
    $ax = Join-Path $PSScriptRoot "..\ax-window-win.ps1"
    return [bool](Wait-UiaChange $ProcessId $Seconds {
            try {
                $lines = & $ax dump -ProcessId $ProcessId -Title $Title 2>$null
            } catch {
                return $false
            }
            [bool]($lines | Select-String -Pattern $Pattern -Quiet)
        })
}

# The sprite's position when it is at rest, else $null: the newest five frame
# lines are all Grounded or Perched, not walking or falling, in one spot (within 2 px).
# Frames land every draw, so this needs no second look after a pause.
function Get-SpriteAtRest([string]$TraceFile) {
    if (-not (Test-Path -LiteralPath $TraceFile)) { return $null }
    $frames = @(Get-Content -LiteralPath $TraceFile | Where-Object { $_ -match '^\d+\.?\d* frame: ' } | Select-Object -Last 5)
    if ($frames.Count -lt 5) { return $null }
    $at = $null
    foreach ($line in $frames) {
        if ($line -match 'walk#|Falling' -or $line -notmatch ' (?:Grounded|Perched) .* sprite\((-?\d+),(-?\d+)\) ') { return $null }
        $here = @{ X = [int]$Matches[1]; Y = [int]$Matches[2] }
        # Within 2 px of the first frame, so a slow drift is not rest.
        if ($at -and ([Math]::Abs($here.X - $at.X) -gt 2 -or [Math]::Abs($here.Y - $at.Y) -gt 2)) { return $null }
        if (-not $at) { $at = $here }
    }
    return $at
}

# Check the last frame for a state pattern
function In-State([string]$LogFile, [string]$StatePattern) {
    if (-not (Test-Path -LiteralPath $LogFile)) { return $false }
    $frame = Get-Content -LiteralPath $LogFile | Where-Object { $_ -match '^frame: ' } | Select-Object -Last 1
    if (-not $frame) { return $false }
    return $frame -match " ($StatePattern) "
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
            ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F 2>&1 | Out-Null }
    }
}
