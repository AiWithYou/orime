$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../scripts/process-lifecycle.ps1"
function Entry($id, $parent, $started, $path) {
    [pscustomobject]@{ Id=$id; ParentId=$parent; StartedUtcTicks="$started"; Path=$path }
}
function Assert-Ids($expected, $actual, $message) {
    $found = (@($actual | ForEach-Object { $_.Id } | Sort-Object) -join ',')
    if ($found -ne $expected) { throw "$message Expected $expected, got $found" }
}
$root = Entry 10 1 100 'C:\app\python.exe'
$child = Entry 11 10 101 'C:\base\python.exe'
$grandchild = Entry 12 11 102 'C:\base\python.exe'
$unrelated = Entry 20 1 105 'C:\base\python.exe'
Assert-Ids '10,11,12' (Select-OrimeProcesses @($root) @($root,$child,$grandchild,$unrelated)) 'Owned descendants only.'
Assert-Ids '' (Select-OrimeProcesses @($root) @((Entry 10 1 200 $root.Path),$child,$unrelated)) 'Reused PID is not ownership.'
Assert-Ids '' (Select-OrimeProcesses @($root) @((Entry 10 1 100 'C:\other\python.exe'))) 'Executable must match.'
Assert-Ids '10' (Select-OrimeProcesses @($root) @($root,(Entry 11 10 99 $root.Path))) 'Older process cannot be a child of a newer root.'
Assert-Ids '11,12' (Select-OrimeProcesses @($root,$child) @($child,$grandchild,$unrelated)) 'Recorded child survives wrapper exit.'
Assert-Ids '' (Select-OrimeProcesses @() @($root,$child,$unrelated)) 'Unrecorded server is never adopted.'
Write-Output 'Process ownership checks passed.'

# Real-process check: an owned wrapper/child stops, an independent process stays.
$directory = Join-Path ([IO.Path]::GetTempPath()) ('orime-process-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $directory | Out-Null
$file = Join-Path $directory 'processes.json'
$shellPath = (Get-Process -Id $PID).Path
$sleepCode = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('Start-Sleep -Seconds 120'))
$parentCode = '$null = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @("-NoProfile", "-EncodedCommand", "' + $sleepCode + '") -WindowStyle Hidden -PassThru; Start-Sleep -Seconds 120'
$parentEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($parentCode))
$ownedProcess = $null
$independent = $null
try {
    $unicodePath = 'C:\' + [char]0x753B + [char]0x50CF + '\orime.exe'
    $unicodeEntry = Entry 25 1 100 $unicodePath
    Write-OrimeProcesses $file @($unicodeEntry)
    if (-not (Test-OrimeIdentity $unicodeEntry (@(Read-OrimeProcesses $file)[0]))) { throw 'Unicode identity did not round trip.' }
    Write-OrimeProcesses $file @()
    $ownedProcess = Start-Process -FilePath $shellPath -ArgumentList @('-NoProfile','-EncodedCommand',$parentEncoded) -WindowStyle Hidden -PassThru
    $independent = Start-Process -FilePath $shellPath -ArgumentList @('-NoProfile','-EncodedCommand',$sleepCode) -WindowStyle Hidden -PassThru
    Register-OrimeProcess $file $ownedProcess
    $rootIdentity = @(Read-OrimeProcesses $file)
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        $tree = @(Select-OrimeProcesses $rootIdentity @(Get-OrimeSnapshot))
        if ($tree.Count -ge 2) { break }
        Start-Sleep -Milliseconds 100
    }
    if ($tree.Count -lt 2) { throw 'Child process was not observed.' }
    Save-OrimeDescendants $file
    # UI shutdown keeps its web server and descendants alive until replying.
    if ((Stop-OrimeProcesses $file -KeepProcessId $ownedProcess.Id) -ne 0) { throw 'Keep server stopped its process tree.' }
    if (@(Read-OrimeProcesses $file).Count -lt 2) { throw 'Kept ownership was lost.' }
    $stopped = Stop-OrimeProcesses $file
    if ($stopped -lt 2) { throw 'Owned wrapper and child were not both stopped.' }
    $independent.Refresh()
    if ($independent.HasExited) { throw 'Independent process was stopped!' }
    $fake = Get-OrimeIdentity $independent
    $fake.StartedUtcTicks = '1'
    Write-OrimeProcesses $file @($fake)
    if ((Stop-OrimeProcesses $file) -ne 0) { throw 'Stale identity was stopped.' }
    $independent.Refresh()
    if ($independent.HasExited) { throw 'Stale record killed a different process.' }
    if ((Stop-OrimeProcesses $file) -ne 0) { throw 'Repeated stop must be harmless.' }
    # Two same-folder sessions, plus a manual caller with no session file.
    $mine = Start-Process -FilePath $shellPath -ArgumentList @('-NoProfile','-EncodedCommand',$sleepCode) -WindowStyle Hidden -PassThru
    $engine = Start-Process -FilePath $shellPath -ArgumentList @('-NoProfile','-EncodedCommand',$sleepCode) -WindowStyle Hidden -PassThru
    try {
        $mineFile = Get-OrimeSessionFile $directory (Get-OrimeIdentity $mine)
        $otherFile = Get-OrimeSessionFile $directory (Get-OrimeIdentity $independent)
        Register-OrimeProcess $mineFile $mine
        Register-OrimeProcess $mineFile $engine
        Register-OrimeProcess $otherFile $independent
        $null = Stop-OrimeSessions $directory -KeepProcessId $PID
        if ($mine.HasExited -or $engine.HasExited -or $independent.HasExited) { throw 'Manual shutdown stopped a managed session.' }
        $null = Stop-OrimeSessions $directory -KeepProcessId $mine.Id
        if (-not $engine.HasExited -or $mine.HasExited -or $independent.HasExited) { throw 'Managed shutdown crossed sessions.' }
        if (-not (Test-Path -LiteralPath $otherFile)) { throw 'Other ownership record was lost.' }
        $null = Stop-OrimeSessions $directory
        if (-not $independent.HasExited) { throw 'Folder shutdown did not stop its remaining session.' }
    } finally {
        foreach ($probe in @($mine,$engine)) { if (-not $probe.HasExited) { $probe.Kill(); $probe.WaitForExit() }; $probe.Dispose() }
        Get-ChildItem -LiteralPath $directory -Filter 'session-*.json' -File | Remove-Item
    }
    Write-Output 'Live process isolation checks passed.'
} finally {
    # Cleanup only the test processes whose handles were created above.
    if ($ownedProcess -and -not $ownedProcess.HasExited) {
        Register-OrimeProcess $file $ownedProcess
        $null = Stop-OrimeProcesses $file
    }
    if ($independent -and -not $independent.HasExited) { $independent.Kill(); $independent.WaitForExit() }
    foreach ($testFile in @($file,"$file.tmp")) {
        if (Test-Path -LiteralPath $testFile) { Remove-Item -LiteralPath $testFile }
    }
    Remove-Item -LiteralPath $directory
}
