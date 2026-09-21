@echo off
chcp 65001 >nul
cd /d "%~dp0"
title DSH Translate Proxy
echo.
echo   ============================================
echo    DSH Translate Proxy        port 8787
echo   ============================================
echo.
echo   Keep this window OPEN while you browse GitHub.
echo   Closing this window stops the proxy.
echo.
where node >nul 2>nul
if %errorlevel%==0 (
    node dsh-translate-proxy.js
) else (
    "C:\Program Files\nodejs\node.exe" dsh-translate-proxy.js
)
echo.
echo   --------------------------------------------
echo   Proxy has stopped.  Press any key to close.
echo   --------------------------------------------
pause >nul