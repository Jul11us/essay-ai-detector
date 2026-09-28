$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Host.UI.RawUI.WindowTitle = "Essay AI Detector"
try { chcp 65001 | Out-Null } catch {}

function Stop-ListenPort([int]$Port) {
    $ids = @()
    try {
        $ids = @(
            Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique
        )
    } catch {}
    if ($ids.Count -eq 0) {
        foreach ($line in (netstat -ano)) {
            if ($line -match (":$Port\s+\S+\s+\S+\s+LISTENING\s+(\d+)\s*$")) {
                $ids += [int]$Matches[1]
            }
        }
        $ids = @($ids | Select-Object -Unique)
    }
    foreach ($procId in $ids) {
        if ($procId -gt 4) {
            Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId" -ErrorAction SilentlyContinue |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Stop-Detector {
    Stop-ListenPort 8000
    Stop-ListenPort 5173
}

$python = Join-Path $Root ".venv-detector\Scripts\python.exe"
if (-not (Test-Path $python)) {
    $python = Join-Path $Root "backend\.venv\Scripts\python.exe"
}
if (-not (Test-Path $python)) {
    Write-Host "Missing .venv-detector. See README."
    Read-Host "Press Enter to exit"
    exit 1
}

$viteCmd = Join-Path $Root "frontend\node_modules\.bin\vite.cmd"
if (-not (Test-Path $viteCmd)) {
    Write-Host "Installing frontend dependencies..."
    Push-Location (Join-Path $Root "frontend")
    npm install
    Pop-Location
}
if (-not (Test-Path $viteCmd)) {
    Write-Host "Missing frontend\node_modules. Run npm install in frontend."
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Stopping leftover detector processes (if any)..."
Stop-Detector
Start-Sleep -Milliseconds 400

Write-Host "Starting detector API (first model load may take 1-2 minutes)..."
$api = Start-Process -FilePath $python -WorkingDirectory (Join-Path $Root "backend") `
    -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000") `
    -PassThru -WindowStyle Hidden

Write-Host "Starting web UI..."
$web = Start-Process -FilePath $viteCmd -WorkingDirectory (Join-Path $Root "frontend") `
    -ArgumentList @("--host", "127.0.0.1", "--port", "5173") `
    -PassThru -WindowStyle Hidden

$watch = @"
`$parent = $PID
do { Start-Sleep -Seconds 1 } while (Get-Process -Id `$parent -ErrorAction SilentlyContinue)
foreach (`$port in 8000, 5173) {
    Get-NetTCPConnection -LocalPort `$port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id `$_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
"@
Start-Process -FilePath "powershell.exe" -WindowStyle Hidden `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $watch) | Out-Null

Write-Host "Waiting for http://127.0.0.1:5173 ..."
for ($i = 0; $i -lt 50; $i++) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect("127.0.0.1", 5173, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(400) -and $c.Connected) {
            $c.EndConnect($iar)
            $c.Close()
            break
        }
        $c.Close()
    } catch {}
    Start-Sleep -Milliseconds 400
}

Start-Process "http://127.0.0.1:5173/"
Write-Host ""
Write-Host "Opened browser  http://127.0.0.1:5173"
Write-Host "Models load only while this window is open. Close it to unload them."
Write-Host "Close this window or press Ctrl+C to stop."
Write-Host ""

try {
    while ($true) {
        if ($null -ne $api -and $api.HasExited) { break }
        Start-Sleep -Seconds 2
    }
} finally {
    Stop-Detector
    if ($null -ne $api -and -not $api.HasExited) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
    if ($null -ne $web -and -not $web.HasExited) { Stop-Process -Id $web.Id -Force -ErrorAction SilentlyContinue }
}
