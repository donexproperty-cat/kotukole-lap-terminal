# K-Term Laptop Agent (PowerShell Edition v1.3.0)
$host.UI.RawUI.WindowTitle = "K-Term ⚡ Physical Laptop Agent (PS v1.3.0)"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}

# Load / Save Local Config (%APPDATA%\KTerm\config.json)
$configDir = Join-Path $env:APPDATA "KTerm"
$configPath = Join-Path $configDir "config.json"
$logDir = Join-Path $env:LOCALAPPDATA "KTerm"
$logPath = Join-Path $logDir "agent.log"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-AgentLog($msg) {
    try {
        if ((Test-Path $logPath) -and ((Get-Item $logPath).Length -gt 2MB)) {
            Move-Item $logPath "$logPath.old" -Force -ErrorAction SilentlyContinue
        }
        $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
        Add-Content -Path $logPath -Value $line -ErrorAction SilentlyContinue
    } catch {}
}

$cfg = @{}
if (Test-Path $configPath) {
    try { $cfg = Get-Content $configPath -Raw | ConvertFrom-Json } catch {}
}

$serverUrl = if ($env:KTERM_SERVER_URL) { $env:KTERM_SERVER_URL.TrimEnd('/') } elseif ($cfg.ServerURL) { $cfg.ServerURL.TrimEnd('/') } else { "https://kotukole.com/lap" }
$agentSecret = if ($env:KTERM_AGENT_SECRET) { $env:KTERM_AGENT_SECRET } elseif ($cfg.AgentSecret) { $cfg.AgentSecret } else { "" }
$agentHeaders = @{}
if ($agentSecret) { $agentHeaders["X-Agent-Secret"] = $agentSecret }
$hostname = if ($cfg.DeviceAlias) { $cfg.DeviceAlias } else { $env:COMPUTERNAME }
$username = $env:USERNAME
$deviceId = "$hostname@$username"
$cores = [string]$env:NUMBER_OF_PROCESSORS
$osName = [System.Environment]::OSVersion.ToString()

$cpuModel = "Windows Processor"
try {
    $regCpu = (Get-ItemProperty -Path "HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0" -ErrorAction SilentlyContinue).ProcessorNameString
    if ($regCpu) { $cpuModel = $regCpu.Trim() }
} catch {}

$gpuName = ""
try {
    $gpu = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($gpu -and $gpu.Name) { $gpuName = $gpu.Name.Trim() }
} catch {}

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "        ⚡ K-TERM PHYSICAL LAPTOP CONNECTOR (PS v1.3.0) ⚡       " -ForegroundColor Cyan
Write-Host "=================================================================`n" -ForegroundColor Cyan
Write-Host "[*] Connecting your laptop to : $serverUrl"
Write-Host "[*] Machine Name              : $hostname"
Write-Host "[*] User Name                 : $username"
Write-Host "[*] Processor (CPU)           : $cpuModel"
if ($gpuName) { Write-Host "[*] Graphics (GPU)            : $gpuName" }
Write-Host "[*] CPU Cores                 : $cores"
Write-Host "[*] Operating OS              : $osName"

# Ensure local copy & Windows Logon Auto-Startup (Scheduled Task) unless disabled
$localAgentPath = Join-Path $configDir "agent.ps1"
if (-not $env:KTERM_NO_STARTUP) {
    try {
        if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
        $scriptSrc = $MyInvocation.MyCommand.ScriptContents
        if ($scriptSrc) {
            Set-Content -Path $localAgentPath -Value $scriptSrc -Encoding UTF8 -Force
        } elseif ($PSCommandPath -and (Test-Path $PSCommandPath)) {
            Copy-Item $PSCommandPath $localAgentPath -Force
        } else {
            Invoke-WebRequest -Uri "$serverUrl/agent.ps1" -OutFile $localAgentPath -UseBasicParsing -ErrorAction SilentlyContinue
        }

        $taskName = "KTermLaptopAgent"
        $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if (-not $existingTask -and (Test-Path $localAgentPath)) {
            $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$localAgentPath`""
            $trigger = New-ScheduledTaskTrigger -AtLogOn
            $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
            Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "K-Term Physical Laptop Agent" -Force | Out-Null
            Write-Host "[+] Auto-Startup              : ENABLED (Task '$taskName' at Windows Logon)" -ForegroundColor Green
            Write-AgentLog "Registered Scheduled Task '$taskName' -> $localAgentPath"
        } elseif ($existingTask) {
            Write-Host "[+] Auto-Startup              : ALREADY ENABLED (Task '$taskName')" -ForegroundColor Green
        }
    } catch {
        Write-Host "[!] Auto-Startup Setup        : Skipped ($($_.Exception.Message))" -ForegroundColor Yellow
    }
}

Write-Host "`n[+] Status: CONNECTED & LISTENING for commands from Server" -ForegroundColor Green
Write-Host "[+] Log File: $logPath`n" -ForegroundColor DarkGray
Write-AgentLog "Agent v1.3.0 started -> $serverUrl ($deviceId)"

# Sleep / Wake event handler
try {
    Register-ObjectEvent -InputObject ([Microsoft.Win32.SystemEvents]) -EventName PowerModeChanged -Action {
        if ($EventArgs.Mode -eq 'Resume') {
            $script:backoffSec = 1
        }
    } | Out-Null
} catch {}

$lastHandledId = ""
$currentWorkDir = (Get-Location).Path
$script:backoffSec = 1

while ($true) {
    try {
        # RAM Stats
        $ramTotal = "Unknown"; $ramUsed = "Unknown"; $ramPct = "0"
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
        $diskTotal = "Unknown"; $diskFree = "Unknown"; $diskPct = "0%"
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
            }
        } catch {}

        # Battery, CPU Temp, Wi-Fi SSID, USB Drives, Pending Reboot, Top 5 Procs
        $batteryPct = ""; $batteryStatus = ""; $cpuTemp = ""; $wifiSsid = ""; $usbStr = ""; $pendingReboot = $false; $topProcs = @()
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
        try {
            $ssidLine = (netsh wlan show interfaces 2>$null | Select-String "^\s*SSID\s*:\s*(.+)$") | Select-Object -First 1
            if ($ssidLine) { $wifiSsid = $ssidLine.Matches[0].Groups[1].Value.Trim() }
        } catch {}
        try {
            $usb = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2" -ErrorAction SilentlyContinue
            if ($usb) { $usbStr = ($usb | ForEach-Object { $_.DeviceID }) -join "," }
        } catch {}
        try {
            $pendingReboot = (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired")
        } catch {}
        try {
            $topProcs = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 | ForEach-Object { @{ name = $_.ProcessName; memMB = [Math]::Round($_.WorkingSet64 / 1MB, 1) } })
        } catch {}

        $bodyObj = @{
            deviceId = $deviceId
            version = "1.3.0"
            hostname = $hostname
            user = $username
            os = $osName
            cpuModel = $cpuModel
            gpu = $gpuName
            ssid = $wifiSsid
            usbDrives = $usbStr
            pendingReboot = $pendingReboot
            topProcs = $topProcs
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
        $jsonBody = $bodyObj | ConvertTo-Json -Depth 4 -Compress

        $pollResp = Invoke-RestMethod -Uri "$serverUrl/api/agent/poll" -Method Post -Body $jsonBody -Headers $agentHeaders -ContentType "application/json" -TimeoutSec 10 -ErrorAction Stop
        $script:backoffSec = 1

        if ($pollResp -and $pollResp.id -and $pollResp.id -ne $lastHandledId) {
            $cmdId = $pollResp.id
            $cmd = $pollResp.cmd
            $lastHandledId = $cmdId

            $timeStr = (Get-Date).ToString("HH:mm:ss")
            Write-Host "[$timeStr] [CMD RECEIVED] $cmd" -ForegroundColor Yellow
            Write-AgentLog "CMD: $cmd"

            $output = ""
            try {
                if ($cmd -match '^\s*cd\s+(.+)$') {
                    $targetDir = $Matches[1].Trim().Trim('"')
                    Push-Location $currentWorkDir
                    Set-Location $targetDir -ErrorAction Stop
                    $currentWorkDir = (Get-Location).Path
                    Pop-Location
                    $output = "Directory changed to: $currentWorkDir"
                } else {
                    $output = cmd.exe /c "cd /d `"$currentWorkDir`" && $cmd" 2>&1 | Out-String
                    if (-not $output) { $output = "(Command completed successfully with no output)" }
                }
            } catch {
                $output = "[Execution Error]: " + $_.Exception.Message
                Write-AgentLog "ERR: $($_.Exception.Message)"
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
        Write-AgentLog "Poll error: $($_.Exception.Message)"
        $script:backoffSec = [Math]::Min(15, $script:backoffSec * 2)
    }

    Start-Sleep -Seconds $script:backoffSec
}
