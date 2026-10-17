@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [WF Market] Node.js not found. Install Node.js 20+ first.
  pause
  exit /b 1
)

start "WF Market Proxy" /min cmd /k node "%~dp0wf-market-proxy.mjs"
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:8898/"

exit /b 0
