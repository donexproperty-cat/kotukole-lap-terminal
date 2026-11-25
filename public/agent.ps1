# K-Term Laptop Agent (PowerShell Edition v1.4.2)
# Compatible with both `irm ... | iex` and direct `.ps1` execution
$AgentVersion = "1.4.2"
$Uninstall  = ($args -contains '-Uninstall')  -or ($env:KTERM_ACTION -eq 'uninstall')
$Status     = ($args -contains '-Status')     -or ($env:KTERM_ACTION -eq 'status')
$Logs       = ($args -contains '-Logs')       -or ($env:KTERM_ACTION -eq 'logs')
$Foreground = ($args -contains '-Foreground') -or ($env:KTERM_FOREGROUND -eq '1')
$host.UI.RawUI.WindowTitle = "K-Term ⚡ Physical Laptop Agent (PS v$AgentVersion)"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}

$configDir = Join-Path $env:APPDATA "KTerm"
$configPath = Join-Path $configDir "config.json"
$logDir = Join-Path $env:LOCALAPPDATA "KTerm"
$logPath = Join-Path $logDir "agent.log"
$taskName = "KTermLaptopAgent"

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name $taskName -ErrorAction SilentlyContinue
    Write-Host "[+] Removed Auto-Startup '$taskName'." -ForegroundColor Yellow
    exit 0
}
if ($Logs) {
    if (Test-Path $logPath) { Get-Content $logPath -Tail 50 } else { Write-Host "No log file yet." }
    exit 0
}
if ($Status) {
    $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Write-Host "Task '$taskName': $(if ($t) { $t.State } else { 'Not Installed' })" -ForegroundColor Cyan
    exit 0
}

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# Single-Instance Mutex to prevent duplicate background agents
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Global\KTermPSAgent", [ref]$createdNew)
if (-not $createdNew) {
    Write-Host "[!] K-Term Agent is already running in the background." -ForegroundColor Yellow
    exit 0
}

function Write-AgentLog($msg) {
    try {
        if ((Test-Path $logPath) -and ((Get-Item $logPath).Length -gt 2MB)) {
            Move-Item $logPath "$logPath.old" -Force -ErrorAction SilentlyContinue
        }
        $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
        Add-Content -Path $logPath -Value $line -ErrorAction SilentlyContinue
    } catch {}
}

# Pre-load common assemblies for faster screenshots/GUI operations
try {
    Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
} catch {}

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
Write-Host "        ⚡ K-TERM PHYSICAL LAPTOP CONNECTOR (PS v$AgentVersion) ⚡       " -ForegroundColor Cyan
Write-Host "=================================================================`n" -ForegroundColor Cyan
Write-Host "[*] Connecting your laptop to : $serverUrl"
Write-Host "[*] Machine Name              : $hostname"
Write-Host "[*] User Name                 : $username"
Write-Host "[*] Processor (CPU)           : $cpuModel"
if ($gpuName) { Write-Host "[*] Graphics (GPU)            : $gpuName" }
Write-Host "[*] CPU Cores                 : $cores"
Write-Host "[*] Operating OS              : $osName"

# Ensure local copy & Windows Logon Auto-Startup (unlimited runtime, survives hours offline)
$localAgentPath = Join-Path $configDir "agent.ps1"
if (-not $env:KTERM_NO_STARTUP) {
    try {
        if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
        $scriptSrc = $MyInvocation.MyCommand.ScriptContents
        if ($scriptSrc) {
            [System.IO.File]::WriteAllText($localAgentPath, $scriptSrc, (New-Object System.Text.UTF8Encoding($false)))
        } elseif ($PSCommandPath -and (Test-Path $PSCommandPath)) {
            Copy-Item $PSCommandPath $localAgentPath -Force
        } else {
            Invoke-WebRequest -Uri "$serverUrl/agent.ps1" -OutFile $localAgentPath -UseBasicParsing -ErrorAction SilentlyContinue
        }

        $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        $regRunPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
        $existingRun = (Get-ItemProperty -Path $regRunPath -Name $taskName -ErrorAction SilentlyContinue).$taskName

        if (-not $existingTask -and -not $existingRun -and (Test-Path $localAgentPath)) {
            try {
                $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$localAgentPath`""
                $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
                $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
                Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "K-Term Physical Laptop Agent" -Force -ErrorAction Stop | Out-Null
                Write-Host "[+] Auto-Startup              : ENABLED (Scheduled Task '$taskName')" -ForegroundColor Green
                Write-AgentLog "Registered Scheduled Task '$taskName' -> $localAgentPath"
            } catch {
                try {
                    $runCmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$localAgentPath`""
                    Set-ItemProperty -Path $regRunPath -Name $taskName -Value $runCmd -Force -ErrorAction Stop
                    Write-Host "[+] Auto-Startup              : ENABLED (User Logon Startup '$taskName')" -ForegroundColor Green
                    Write-AgentLog "Registered HKCU Run '$taskName' -> $localAgentPath"
                } catch {
                    Write-Host "[!] Auto-Startup Setup        : Skipped ($($_.Exception.Message))" -ForegroundColor Yellow
                }
            }
        } elseif ($existingTask -or $existingRun) {
            Write-Host "[+] Auto-Startup              : ALREADY ENABLED ('$taskName')" -ForegroundColor Green
        }
    } catch {
        Write-Host "[!] Auto-Startup Setup        : Skipped ($($_.Exception.Message))" -ForegroundColor Yellow
    }
}

# If launched interactively via `irm ... | iex` (no $PSCommandPath), hand off to hidden background process so user can close this window!
if (-not $PSCommandPath -and -not $Foreground -and (Test-Path $localAgentPath)) {
    try { $mutex.ReleaseMutex(); $mutex.Dispose() } catch {}
    Start-Process "powershell.exe" -WindowStyle Hidden -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$localAgentPath`""
    Write-Host "`n[+] Status: RUNNING IN BACKGROUND! You can safely close this PowerShell window." -ForegroundColor Green
    Write-Host "[+] Log File: $logPath`n" -ForegroundColor DarkGray
    return
}

Write-Host "`n[+] Status: CONNECTED & LISTENING for commands from Server" -ForegroundColor Green
Write-Host "[+] Log File: $logPath`n" -ForegroundColor DarkGray
Write-AgentLog "Agent v$AgentVersion started -> $serverUrl ($deviceId)"

# Sleep / Wake & Network Change event handlers (instant reconnect when Wi-Fi/Data turns on)
try {
    Register-ObjectEvent -InputObject ([Microsoft.Win32.SystemEvents]) -EventName PowerModeChanged -Action {
        if ($EventArgs.Mode -eq 'Resume') { $script:backoffSec = 1 }
    } | Out-Null
    Register-ObjectEvent -InputObject ([System.Net.NetworkInformation.NetworkChange]) -EventName NetworkAddressChanged -Action {
        $script:backoffSec = 1
    } | Out-Null
} catch {}

$lastHandledId = ""
$currentWorkDir = (Get-Location).Path
$script:backoffSec = 1
$lastOtaCheck = [DateTime]::MinValue

while ($true) {
    # Wait quietly if no network adapter/data is connected yet (works even hours later)
    while (-not ([System.Net.NetworkInformation.NetworkInterface]::GetIsNetworkAvailable())) {
        Start-Sleep -Seconds 3
    }

    try {
        # Auto-OTA Version Check every 30 minutes
        if (([DateTime]::UtcNow - $lastOtaCheck).TotalMinutes -ge 30) {
            $lastOtaCheck = [DateTime]::UtcNow
            try {
                $verResp = Invoke-RestMethod -Uri "$serverUrl/api/agent/version" -Method Get -TimeoutSec 6 -ErrorAction SilentlyContinue
                if ($verResp -and $verResp.version -and ($verResp.version -ne $AgentVersion) -and (Test-Path $localAgentPath)) {
                    $tmpNew = "$localAgentPath.new"
                    Invoke-WebRequest -Uri "$serverUrl/agent.ps1" -OutFile $tmpNew -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
                    if ((Test-Path $tmpNew) -and ((Get-Item $tmpNew).Length -gt 1000)) {
                        Move-Item $tmpNew $localAgentPath -Force
                        Write-AgentLog "Auto-OTA updated to v$($verResp.version). Restarting..."
                        try { $mutex.ReleaseMutex(); $mutex.Dispose() } catch {}
                        Start-Process "powershell.exe" -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$localAgentPath`""
                        exit 0
                    }
                }
            } catch {}
        }

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
            version = $AgentVersion
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
