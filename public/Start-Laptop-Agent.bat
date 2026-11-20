@echo off
setlocal EnableDelayedExpansion
title KotuKole ⚡ Physical Laptop Agent Launcher
color 0B
cls

echo =================================================================
echo        ⚡ KOTUKOLE PHYSICAL LAPTOP CONNECTOR LAUNCHER ⚡         
echo =================================================================
echo.
echo [*] Cleaning old temp files...
del /f /q "%TEMP%\KotuKole-Laptop.exe" 2>nul
del /f /q "%TEMP%\KotuKole-Agent-Fixed.exe" 2>nul
del /f /q "%TEMP%\KotuKoleAgent.exe" 2>nul

echo [*] Downloading latest KotuKole Laptop Agent...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $rand = Get-Random; Invoke-WebRequest -Uri ('https://kotukole.com/lap/KotuKole-Laptop.exe?v=' + $rand) -OutFile '%TEMP%\KotuKole-Laptop.exe'" 2>nul

if exist "%TEMP%\KotuKole-Laptop.exe" (
    echo [+] Starting KotuKole Laptop Agent...
    echo.
    "%TEMP%\KotuKole-Laptop.exe"
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
