@echo off
title K-Term Webcam Agent
color 0A
cls
echo =================================================================
echo        [+] K-TERM WEBCAM AGENT (WINDOWS CLIENT)
echo =================================================================
echo.
echo [*] Connecting to Server: https://kotukole.com/lap
echo [*] Camera Status       : Listening for remote capture requests...
echo.
echo [+] Status: RUNNING & ACTIVE
echo [+] Keep this window open or minimized while using the web console.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -sta -File "%~dp0webcam-agent.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Agent stopped with error code %errorlevel%.
    pause
)
