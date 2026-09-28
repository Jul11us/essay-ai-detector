$ErrorActionPreference = "Continue"

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

Stop-ListenPort 8000
Stop-ListenPort 5173
Write-Host "Stopped detector on 8000 and 5173 (if any). Models are unloaded."
Read-Host "Press Enter to exit"
