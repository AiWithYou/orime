function Test-OrimeIdentity($Expected, $Actual) {
    $null -ne $Actual -and $Expected.Id -eq $Actual.Id -and
    "$($Expected.StartedUtcTicks)" -ceq "$($Actual.StartedUtcTicks)" -and
    [string]::Equals($Expected.Path, $Actual.Path, [StringComparison]::OrdinalIgnoreCase)
}
function Get-OrimeIdentity($Process, $ParentId = 0) {
    # Retain a handle before reading identity; Kill() later uses this same process.
    $null = $Process.Handle
    $ticks = $Process.StartTime.ToUniversalTime().Ticks
    $ticks = $ticks - ($ticks % 10) # Match CIM's microsecond resolution.
    [pscustomobject]@{
        Id = $Process.Id
        ParentId = [int]$ParentId
        StartedUtcTicks = "$ticks"
        Path = $Process.Path
    }
}
function Get-OrimeSnapshot {
    foreach ($row in Get-CimInstance Win32_Process) {
        if ($row.ExecutablePath -and $row.CreationDate) {
            [pscustomobject]@{
                Id = [int]$row.ProcessId
                ParentId = [int]$row.ParentProcessId
                StartedUtcTicks = "$($row.CreationDate.ToUniversalTime().Ticks)"
                Path = $row.ExecutablePath
            }
        }
    }
}
function Select-OrimeProcesses($Owned, $Snapshot) {
    $selected = @{}
    foreach ($entry in $Owned) {
        foreach ($current in $Snapshot) {
            if (Test-OrimeIdentity $entry $current) { $selected[$current.Id] = $current }
        }
    }
    do {
        $added = $false
        foreach ($current in $Snapshot) {
            $parent = $selected[$current.ParentId]
            if ($null -ne $parent -and -not $selected.ContainsKey($current.Id) -and
                [long]$current.StartedUtcTicks -ge [long]$parent.StartedUtcTicks) {
                $selected[$current.Id] = $current
                $added = $true
            }
        }
    } while ($added)
    $selected.Values
}
function Read-OrimeProcesses($File) {
    if (-not (Test-Path -LiteralPath $File)) { return }
    $ledger = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($ledger.version -ne 1) { throw 'Unsupported process record. No processes were stopped.' }
    $ledger.processes
}
function Write-OrimeProcesses($File, $Processes) {
    $temporary = "$File.tmp"
    $json = @{ version = 1; processes = @($Processes) } | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $File -Force
}
function Register-OrimeProcess($File, $Process) {
    $entries = @(Read-OrimeProcesses $File)
    $identity = Get-OrimeIdentity $Process
    Write-OrimeProcesses $File (@($entries | Where-Object { $_.Id -ne $identity.Id }) + @($identity))
}
function Save-OrimeDescendants($File) {
    $owned = @(Read-OrimeProcesses $File)
    if ($owned.Count) {
        Write-OrimeProcesses $File @(Select-OrimeProcesses $owned @(Get-OrimeSnapshot))
    }
}
function Enter-OrimeLifecycle($Directory) {
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    # Start and stop cannot race over the ownership record.
    [IO.File]::Open((Join-Path $Directory 'lifecycle.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
}
function Stop-OrimeTargets($Targets) {
    $stopped = 0
    $failures = @()
    foreach ($entry in ($targets | Sort-Object { [long]$_.StartedUtcTicks } -Descending)) {
        $process = Get-Process -Id $entry.Id -ErrorAction SilentlyContinue
        if ($null -eq $process) { continue }
        try {
            if (Test-OrimeIdentity $entry (Get-OrimeIdentity $process)) {
                $process.Kill()
                if (-not $process.WaitForExit(10000)) { throw 'Process did not exit.' }
                $stopped++
            }
        } catch {
            # A child (notably conhost) can exit with its parent between the
            # snapshot and identity lookup. That is already a successful stop.
            $message = $_.Exception.Message
            $exited = $false
            try { $exited = $process.HasExited } catch { }
            if (-not $exited) { $failures += "PID $($entry.Id): $message" }
        }
        finally { $process.Dispose() }
    }
    if ($failures.Count) { throw ($failures -join "`n") }
    $stopped
}
function Stop-OrimeProcesses($File, [int]$KeepProcessId = 0) {
    $snapshot = @(Get-OrimeSnapshot)
    $owned = @(Read-OrimeProcesses $File)
    $kept = @(Select-OrimeProcesses @($snapshot | Where-Object { $_.Id -eq $KeepProcessId }) $snapshot)
    $targets = @(Select-OrimeProcesses $owned $snapshot | Where-Object { $_.Id -notin $kept.Id })
    $stopped = Stop-OrimeTargets $targets
    Write-OrimeProcesses $File @($owned | Where-Object { $_.Id -in $kept.Id })
    $stopped
}
function Get-OrimeSessionFile($Directory, $Identity) {
    Join-Path $Directory ('session-{0}-{1}.json' -f $Identity.Id, $Identity.StartedUtcTicks)
}
function Clear-OrimeFinishedSessions($Directory) {
    $files = @(Get-ChildItem -LiteralPath $Directory -File -Filter 'session-*.json')
    if (-not $files.Count) { return }
    $snapshot = @(Get-OrimeSnapshot)
    foreach ($file in $files) {
        $live = @(Select-OrimeProcesses @(Read-OrimeProcesses $file.FullName) $snapshot)
        if (-not $live.Count) { Remove-Item -LiteralPath $file.FullName }
    }
}
function Stop-OrimeSessions($Directory, [int]$KeepProcessId = 0) {
    if ($KeepProcessId -gt 0) {
        $server = Get-Process -Id $KeepProcessId -ErrorAction Stop
        try { $identity = Get-OrimeIdentity $server } finally { $server.Dispose() }
        $file = Get-OrimeSessionFile $Directory $identity
        $match = @(Read-OrimeProcesses $file | Where-Object { Test-OrimeIdentity $_ $identity })
        if (-not $match.Count) { return 0 }
        return (Stop-OrimeProcesses $file -KeepProcessId $KeepProcessId)
    }
    $count = 0
    $files = @(Get-ChildItem -LiteralPath $Directory -File -Filter 'session-*.json')
    # The folder-wide BAT can also stop sessions registered by older launchers.
    $legacy = Join-Path $Directory 'processes.json'
    if (Test-Path -LiteralPath $legacy) { $files += Get-Item -LiteralPath $legacy }
    foreach ($file in $files) {
        $count += Stop-OrimeProcesses $file.FullName
        Remove-Item -LiteralPath $file.FullName
    }
    $count
}
