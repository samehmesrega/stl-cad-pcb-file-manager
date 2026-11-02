@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install || goto :fail
)
if not exist dist\index.html (
  echo Building the app...
  call npm run build || goto :fail
)
node server/index.ts --open
if errorlevel 1 goto :fail
exit /b 0
:fail
echo.
echo Something went wrong. Read the message above.
pause
