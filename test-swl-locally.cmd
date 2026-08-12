@echo off
rem SWL no-install browser test platform. This launcher never installs dependencies.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.22.2 or the supported Node 24 LTS runtime is required.
  echo No application or dependency was installed.
  pause
  exit /b 1
)

node scripts\local-test-platform.mjs
set "SWL_TEST_EXIT=%ERRORLEVEL%"
if not "%SWL_TEST_EXIT%"=="0" pause
exit /b %SWL_TEST_EXIT%
