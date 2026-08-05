@echo off
rem SWL Pricing and Inventory Control - one-click start (Windows).
rem Double-click this file. It prepares everything on first run, starts the
rem application server on this computer and opens the app in your browser.
rem Real live prices need SERPAPI_KEY in a .env file (copy .env.example).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org (version 22) and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies...
  call npm install || (pause & exit /b 1)
)
if not exist server\data\catalogue-items.json (
  echo Seeding sample data...
  call npm run seed || (pause & exit /b 1)
)
if not exist dist\index.html (
  echo Building the application...
  call npm run build || (pause & exit /b 1)
)

echo Starting the SWL server. Keep this window open while using the app.
start "" http://127.0.0.1:8787
call npm run server
pause
