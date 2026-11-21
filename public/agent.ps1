# K-Term Laptop Agent (PowerShell Edition)
$host.UI.RawUI.WindowTitle = "K-Term ⚡ Physical Laptop Agent (PS)"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "        ⚡ K-TERM PHYSICAL LAPTOP CONNECTOR (PS AGENT) ⚡       " -ForegroundColor Cyan
Write-Host "=================================================================`n" -ForegroundColor Cyan

$serverUrl = "https://kotukole.com/lap"
$hostname = $env:COMPUTERNAME
$username = $env:USERNAME
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

        $bodyObj = @{
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
        }
        $jsonBody = $bodyObj | ConvertTo-Json -Compress

        $pollResp = Invoke-RestMethod -Uri "$serverUrl/api/agent/poll" -Method Post -Body $jsonBody -ContentType "application/json" -TimeoutSec 10 -ErrorAction SilentlyContinue

        if ($pollResp -and $pollResp.id -and $pollResp.id -ne $lastHandledId) {
            $cmdId = $pollResp.id
            $cmd = $pollResp.cmd
            $lastHandledId = $cmdId

            $timeStr = (Get-Date).ToString("HH:mm:ss")
            Write-Host "[$timeStr] [CMD RECEIVED] $cmd" -ForegroundColor Yellow

            $output = ""
            try {
                $procInfo = New-Object System.Diagnostics.ProcessStartInfo
                if ($cmd -match '^\s*powershell(?:\.exe)?\s+(-.*)$') {
                    $procInfo.FileName = "powershell.exe"
                    $procInfo.Arguments = $Matches[1]
                } elseif ($cmd -match '^\s*(?:\$|Get-|Set-|New-|Remove-|Start-|Stop-|Invoke-)') {
                    $procInfo.FileName = "powershell.exe"
                    $procInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command `"$($cmd.Replace('"', '\"'))`""
                } else {
                    $procInfo.FileName = "cmd.exe"
                    $procInfo.Arguments = "/c " + $cmd
                }
                $procInfo.RedirectStandardOutput = $true
                $procInfo.RedirectStandardError = $true
                $procInfo.UseShellExecute = $false
                $procInfo.CreateNoWindow = $true

                $proc = [System.Diagnostics.Process]::Start($procInfo)
                $outTask = $proc.StandardOutput.ReadToEndAsync()
                $errTask = $proc.StandardError.ReadToEndAsync()

                if ($proc.WaitForExit(25000)) {
                    $stdout = $outTask.Result
                    $stderr = $errTask.Result
                    $output = $stdout
                    if ($stderr) {
                        if ($output) { $output += "`n" }
                        $output += $stderr
                    }
                } else {
                    try { $proc.Kill() } catch {}
                    $output = "[Execution Timeout: Process exceeded 25 seconds and was safely terminated]"
                }
                if (-not $output.Trim()) { $output = "(Command completed successfully with no output)" }
            } catch {
                $output = "[Execution Error]: " + $_.Exception.Message
            }

            $resObj = @{
                id = $cmdId
                output = $output
            }
            $resJson = $resObj | ConvertTo-Json -Compress
            Invoke-RestMethod -Uri "$serverUrl/api/agent/result" -Method Post -Body $resJson -ContentType "application/json" -TimeoutSec 10 -ErrorAction SilentlyContinue | Out-Null
            
            $timeDone = (Get-Date).ToString("HH:mm:ss")
            Write-Host "[$timeDone] [RESULT SENT BACK TO WEB CONSOLE]" -ForegroundColor Green
        }
    } catch {
        # Silent retry
    }

    Start-Sleep -Seconds 1
}
