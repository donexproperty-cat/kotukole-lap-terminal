param(
    [string]$ServerURL = "https://kotukole.com/lap",
    [string]$AgentSecret = "",
    [switch]$Uninstall
)

$taskName = "KTermLaptopAgent"

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "[+] Removed scheduled task '$taskName'." -ForegroundColor Yellow
    exit 0
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exePath = Join-Path $scriptDir "K-Term.exe"
$psPath = Join-Path $scriptDir "agent.ps1"

if (Test-Path $exePath) {
    $argStr = "`"$ServerURL`""
    if ($AgentSecret) { $argStr += " `"$AgentSecret`"" }
    $action = New-ScheduledTaskAction -Execute $exePath -Argument $argStr
} elseif (Test-Path $psPath) {
    $cmd = "if (`"$AgentSecret`") { `$env:KTERM_AGENT_SECRET = `"$AgentSecret`" }; `$env:KTERM_SERVER_URL = `"$ServerURL`"; & `"$psPath`""
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`""
} else {
    $cmd = "if (`"$AgentSecret`") { `$env:KTERM_AGENT_SECRET = `"$AgentSecret`" }; `$env:KTERM_SERVER_URL = `"$ServerURL`"; irm `"$ServerURL/agent.ps1`" | iex"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`""
}

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "K-Term Physical Laptop Agent Auto-Startup" -Force | Out-Null
Write-Host "[+] Installed '$taskName' to start automatically at Windows logon!" -ForegroundColor Green
Write-Host "[*] To remove later, run: .\Install-Startup.ps1 -Uninstall" -ForegroundColor Cyan
