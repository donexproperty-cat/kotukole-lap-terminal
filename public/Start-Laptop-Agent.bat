@echo off
setlocal EnableDelayedExpansion
title K-Term ⚡ Physical Laptop Agent Launcher
color 0B
cls

echo =================================================================
echo        ⚡ K-TERM PHYSICAL LAPTOP CONNECTOR LAUNCHER ⚡         
echo =================================================================
echo.
echo [*] Cleaning old temp files...
del /f /q "%TEMP%\K-Term.exe" 2>nul
del /f /q "%TEMP%\KotuKole-Laptop.exe" 2>nul
del /f /q "%TEMP%\KotuKoleAgent.exe" 2>nul

echo [*] Downloading latest K-Term Laptop Agent...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $rand = Get-Random; Invoke-WebRequest -Uri ('https://kotukole.com/lap/K-Term.exe?v=' + $rand) -OutFile '%TEMP%\K-Term.exe'" 2>nul

if exist "%TEMP%\K-Term.exe" (
    echo [+] Starting K-Term Laptop Agent...
    echo.
    "%TEMP%\K-Term.exe"
    goto finish
)

echo [!] Could not download binary. Trying direct PowerShell agent fallback...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://kotukole.com/lap/agent.ps1 | iex"

:finish
echo.
echo =================================================================
echo [!] Agent has stopped. Press any key to close this window...
echo =================================================================
pause
