param([int]$KeepProcessId = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. "$PSScriptRoot/scripts/process-lifecycle.ps1"
$runDirectory = Join-Path $PSScriptRoot '.run'
$lock = Enter-OrimeLifecycle $runDirectory
try {
    $count = Stop-OrimeSessions $runDirectory -KeepProcessId $KeepProcessId
    Write-Output "Orime: stopped $count owned process(es). Unrecorded processes were not touched."
} finally { $lock.Dispose() }
