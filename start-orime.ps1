param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
New-Item -ItemType Directory -Force '.run' | Out-Null
. "$PSScriptRoot/scripts/process-lifecycle.ps1"
$runDirectory = Join-Path $PSScriptRoot '.run'
$processFile = $null
$launched = @()
$lock = Enter-OrimeLifecycle $runDirectory
try {
    $config = if (Test-Path 'settings.local.json') { Get-Content 'settings.local.json' -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    $port = if ($config.canvasPort) { [int]$config.canvasPort } else { 8199 }
    $env:CANVAS_PORT = $port.ToString()
    $env:COMFY_URL = if ($config.comfyUrl) { $config.comfyUrl.TrimEnd('/') } else { 'http://127.0.0.1:8188' }
    $comfyUri = [uri]$env:COMFY_URL
    if ($config.pythonPath) {
        $packagePath = (Resolve-Path -LiteralPath $config.pythonPath).Path
        $env:PYTHONPATH = if ($env:PYTHONPATH) { "$packagePath;$env:PYTHONPATH" } else { $packagePath }
    }
    if ($comfyUri.Scheme -ne 'http' -or -not $comfyUri.IsLoopback -or $comfyUri.AbsolutePath -ne '/' -or $comfyUri.UserInfo -or $comfyUri.Query -or $comfyUri.Fragment) { throw 'ComfyUIの接続先にはローカルPCのHTTPアドレスを指定してください。' }
    $healthUrl = "http://127.0.0.1:$port/canvas-api/health"
    try { $running = Invoke-RestMethod $healthUrl -TimeoutSec 2 } catch { $running = $null }
    if ($running.service -ne 'orime') {
        Clear-OrimeFinishedSessions $runDirectory
        $binary = Join-Path $PSScriptRoot 'orime.exe'
        if (-not (Test-Path -LiteralPath $binary)) {
            $binary = Join-Path $PSScriptRoot 'target/release/orime.exe'
            if (Get-Command cargo -ErrorAction SilentlyContinue) {
                & cargo build --release --locked
                if ($LASTEXITCODE -ne 0) { throw 'Rustのビルドに失敗しました。' }
            } elseif (-not (Test-Path -LiteralPath $binary)) { throw 'Rustを導入するか、ビルド済みパッケージを利用してください。' }
        }
        $canvasProcess = Start-Process -FilePath $binary -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput ".run/canvas-$port.stdout.log" -RedirectStandardError ".run/canvas-$port.stderr.log" -PassThru
        $launched += $canvasProcess
        $processFile = Get-OrimeSessionFile $runDirectory (Get-OrimeIdentity $canvasProcess)
        Register-OrimeProcess $processFile $canvasProcess
        for ($i=0; $i -lt 40; $i++) {
            if ($canvasProcess.HasExited) { break }
            try { $running = Invoke-RestMethod $healthUrl -TimeoutSec 2 } catch { $running = $null }
            if ($running.service -eq 'orime' -and $running.pid -eq $canvasProcess.Id) { break }
            Start-Sleep -Milliseconds 250
        }
        if ($running.service -ne 'orime' -or $running.pid -ne $canvasProcess.Id -or $canvasProcess.HasExited) {
            throw "画面サーバーが起動しませんでした。.run/canvas-$port.stderr.log を確認してください。"
        }
        if ($config.python -and $config.comfyDirectory) {
            try { Invoke-RestMethod "$env:COMFY_URL/system_stats" -TimeoutSec 2 | Out-Null } catch {
                $comfyPort = ([uri]$env:COMFY_URL).Port
                $listenAddress = if ($comfyUri.Host -eq '[::1]') { '::1' } else { '127.0.0.1' }
                $comfyArguments = @('main.py', '--listen', $listenAddress, '--port', "$comfyPort", '--disable-auto-launch')
                if ($config.comfyArgs) { $comfyArguments += @($config.comfyArgs) }
                # Quote each Windows argument so model/config paths containing spaces work.
                $quotedArgs = $comfyArguments | ForEach-Object { '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
                $comfyProcess = Start-Process -FilePath $config.python -ArgumentList ($quotedArgs -join ' ') -WorkingDirectory $config.comfyDirectory -WindowStyle Hidden -RedirectStandardOutput ".run/comfy-$port.stdout.log" -RedirectStandardError ".run/comfy-$port.stderr.log" -PassThru
                $launched += $comfyProcess
                Register-OrimeProcess $processFile $comfyProcess
            }
        }
        Save-OrimeDescendants $processFile
    }
    Write-Output "Orime: http://127.0.0.1:$port"
    if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$port" }
} catch {
    if ($launched.Count) {
        $roots = @(foreach ($process in $launched) { if (-not $process.HasExited) { Get-OrimeIdentity $process } })
        if ($processFile -and (Test-Path -LiteralPath $processFile)) { $roots += @(Read-OrimeProcesses $processFile) }
        $null = Stop-OrimeTargets @(Select-OrimeProcesses $roots @(Get-OrimeSnapshot))
        if ($processFile -and (Test-Path -LiteralPath $processFile)) { Remove-Item -LiteralPath $processFile }
    }
    throw
} finally {
    foreach ($process in $launched) { $process.Dispose() }
    $lock.Dispose()
}
