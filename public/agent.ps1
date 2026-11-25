# K-Term Laptop Agent (PowerShell Edition)
$host.UI.RawUI.WindowTitle = "K-Term ⚡ Physical Laptop Agent (PS)"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "        ⚡ K-TERM PHYSICAL LAPTOP CONNECTOR (PS AGENT) ⚡       " -ForegroundColor Cyan
Write-Host "=================================================================`n" -ForegroundColor Cyan

$serverUrl = if ($env:KTERM_SERVER_URL) { $env:KTERM_SERVER_URL.TrimEnd('/') } else { "https://kotukole.com/lap" }
$agentSecret = if ($env:KTERM_AGENT_SECRET) { $env:KTERM_AGENT_SECRET } else { "" }
$agentHeaders = @{}
if ($agentSecret) { $agentHeaders["X-Agent-Secret"] = $agentSecret }
$hostname = $env:COMPUTERNAME
$username = $env:USERNAME
$deviceId = "$hostname@$username"
$cores = [string]$env:NUMBER_OF_PROCESSORS
$osName = [System.Environment]::OSVersion.ToString()

$cpuModel = "Windows Processor"
try {
    $regCpu = (Get-ItemProperty -Path "HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0" -ErrorAction SilentlyContinue).ProcessorNameString
    if ($regCpu) { $cpuModel = $regCpu.Trim() }
} catch {}

Write-Host "[*] Connecting your laptop to : $serverUrl"
Write-Host "[*] Machine Name              : $hostname"
Write-Host "[*] User Name                 : $username"
Write-Host "[*] Processor (CPU)           : $cpuModel"
Write-Host "[*] CPU Cores                 : $cores"
Write-Host "[*] Operating OS              : $osName"
Write-Host "`n[+] Status: CONNECTED & LISTENING for commands from Server" -ForegroundColor Green
Write-Host "[+] Keep this window open while using the web console.`n"

$lastHandledId = ""

while ($true) {
    try {
        # RAM Stats
        $ramTotal = "Unknown"
        $ramUsed = "Unknown"
        $ramPct = "0"
        try {
            $osWmi = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
            if ($osWmi) {
                $totalGb = [Math]::Round($osWmi.TotalVisibleMemorySize / 1024 / 1024, 1)
                $freeGb = [Math]::Round($osWmi.FreePhysicalMemory / 1024 / 1024, 1)
                $usedGb = [Math]::Round($totalGb - $freeGb, 1)
                $ramTotal = "$totalGb GB"
                $ramUsed = "$usedGb GB"
                $ramPct = [string][Math]::Round(($usedGb / $totalGb) * 100)
            }
        } catch {}

        # Disk Stats
        $diskTotal = "Unknown"
        $diskFree = "Unknown"
        $diskPct = "0%"
        try {
            $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue
            if ($disks) {
                $mainDisk = $disks | Where-Object { $_.DeviceID -eq 'C:' }
                if (-not $mainDisk) { $mainDisk = $disks[0] }
                $totalGb = [Math]::Round($mainDisk.Size / 1GB, 1)
                $freeGb = [Math]::Round($mainDisk.FreeSpace / 1GB, 1)
                $usedGb = [Math]::Round($totalGb - $freeGb, 1)
                $diskTotal = "$totalGb GB ($($mainDisk.DeviceID))"
                $diskFree = "$freeGb GB Free"
                $diskPct = [string][Math]::Round(($usedGb / $totalGb) * 100) + "%"
            } else {
                $cDrive = Get-PSDrive C -ErrorAction SilentlyContinue
                if ($cDrive) {
                    $dTotal = [Math]::Round(($cDrive.Used + $cDrive.Free) / 1GB, 1)
                    $dFree = [Math]::Round($cDrive.Free / 1GB, 1)
                    $diskTotal = "$dTotal GB (C:)"
                    $diskFree = "$dFree GB Free"
                    $diskPct = [string][Math]::Round(($cDrive.Used / ($cDrive.Used + $cDrive.Free)) * 100) + "%"
                }
            }
        } catch {}

        # Battery & CPU Temp (best-effort)
        $batteryPct = ""
        $batteryStatus = ""
        $cpuTemp = ""
        try {
            $bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($bat) {
                $batteryPct = "$($bat.EstimatedChargeRemaining)%"
                $batteryStatus = if ($bat.BatteryStatus -eq 2) { "Charging/AC" } else { "On Battery" }
            }
        } catch {}
        try {
            $tz = Get-CimInstance -Namespace "root\WMI" -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($tz -and $tz.CurrentTemperature) {
                $c = [Math]::Round(($tz.CurrentTemperature / 10) - 273.15, 1)
                if ($c -gt 0 -and $c -lt 125) { $cpuTemp = "${c}°C" }
            }
        } catch {}

        $bodyObj = @{
            deviceId = $deviceId
            hostname = $hostname
            user = $username
            os = $osName
            cpuModel = $cpuModel
            cores = $cores
            ramTotal = $ramTotal
            ramUsed = $ramUsed
            ramPercent = $ramPct
            diskTotal = $diskTotal
            diskFree = $diskFree
            diskPercent = $diskPct
            battery = $batteryPct
            batteryStatus = $batteryStatus
            cpuTemp = $cpuTemp
        }
        $jsonBody = $bodyObj | ConvertTo-Json -Compress

        $pollResp = Invoke-RestMethod -Uri "$serverUrl/api/agent/poll" -Method Post -Body $jsonBody -Headers $agentHeaders -ContentType "application/json" -TimeoutSec 10 -ErrorAction SilentlyContinue

        if ($pollResp -and $pollResp.id -and $pollResp.id -ne $lastHandledId) {
            $cmdId = $pollResp.id
            $cmd = $pollResp.cmd
            $lastHandledId = $cmdId

            $timeStr = (Get-Date).ToString("HH:mm:ss")
            Write-Host "[$timeStr] [CMD RECEIVED] $cmd" -ForegroundColor Yellow

            $output = ""
            try {
                $output = cmd.exe /c $cmd 2>&1 | Out-String
                if (-not $output) { $output = "(Command completed successfully with no output)" }
            } catch {
                $output = "[Execution Error]: " + $_.Exception.Message
            }

            $resObj = @{
                id = $cmdId
                output = $output
            }
            $resJson = $resObj | ConvertTo-Json -Compress
            Invoke-RestMethod -Uri "$serverUrl/api/agent/result" -Method Post -Body $resJson -Headers $agentHeaders -ContentType "application/json" -TimeoutSec 10 -ErrorAction SilentlyContinue | Out-Null
            
            $timeDone = (Get-Date).ToString("HH:mm:ss")
            Write-Host "[$timeDone] [RESULT SENT BACK TO WEB CONSOLE]" -ForegroundColor Green
        }
    } catch {
        # Silent retry
    }

    Start-Sleep -Seconds 1
}
