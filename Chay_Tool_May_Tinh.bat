@echo off
title Discord Activity Automator - May Tinh Local
cd /d "%~dp0"
echo ========================================================
echo     DANG KHOI DONG DISCORD MISSION CONTROL (LOCAL)
echo ========================================================
echo.
echo Dang khoi dong may chu Local... Vui long cho 3 giay.
echo.
start /b node server.js
timeout /t 3 /nobreak >nul
echo Dang mo trinh duyet den http://localhost:3000 ...
start http://localhost:3000
echo.
echo Tool dang chay ngam tren may tinh. De tat tool, dong cua so nay lai.
pause
