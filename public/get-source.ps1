# K-Term Console Source Code Downloader & Extractor
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "      ⚡ DOWNLOADING K-TERM CONSOLE SOURCE TO DESKTOP ⚡         " -ForegroundColor Cyan
Write-Host "=================================================================`n" -ForegroundColor Cyan

$desktop = [Environment]::GetFolderPath('Desktop')
$targetFolder = Join-Path $desktop "K-Term-Source"

if (-not (Test-Path $targetFolder)) {
    New-Item -ItemType Directory -Path $targetFolder -Force | Out-Null
}

$zipPath = Join-Path $targetFolder "source.zip"

Write-Host "[*] Target Folder: $targetFolder"
Write-Host "[*] Downloading source package from Server..." -ForegroundColor Yellow

Invoke-WebRequest -Uri "https://kotukole.com/lap/K-Term-Source.zip" -OutFile $zipPath

if (Test-Path $zipPath) {
    Write-Host "[+] Extracting project files..." -ForegroundColor Green
    Expand-Archive -Path $zipPath -DestinationPath $targetFolder -Force
    Remove-Item -Path $zipPath -Force
    
    Write-Host "`n[+] SUCCESS! All files extracted to Desktop." -ForegroundColor Green
    Write-Host "[*] Opening folder in File Explorer..."
    Start-Process explorer.exe -ArgumentList $targetFolder
    
    Get-ChildItem -Path $targetFolder | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
} else {
    Write-Host "[!] Download failed. Please check internet connection." -ForegroundColor Red
}
