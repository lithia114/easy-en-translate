@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Stop DSH Translate Proxy
echo.
echo   Stopping the DSH translate proxy on port 8787 ...
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>nul
    echo   Killed process %%a
    set FOUND=1
)
if "%FOUND%"=="0" echo   Nothing was listening on port 8787.
echo.
echo   Done.  Press any key to close.
pause >nul