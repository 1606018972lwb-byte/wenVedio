@echo off
cd /d %~dp0
title wenVedio Server
node src/server.js
echo.
echo Server exited. Press any key to close.
pause >nul
