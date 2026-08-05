@echo off
rem SWL Pricing and Inventory Control - one-click start for Windows.
rem Double-click this file. First run installs, seeds and builds by itself,
rem then it starts the local server and opens the app in your browser.
rem Real live prices need SERPAPI_KEY in a .env file - see .env.example.
setlocal
cd /d "%~dp0"
echo SWL Pricing and Inventory Control - preparing... > swl-start.log
echo SWL Pricing and Inventory Control
echo Keep this window open while using the app.
echo.

where node >nul 2>nul
if errorlevel 1 goto no_node

if exist node_modules goto deps_ok
echo First run: installing dependencies. This can take a few minutes...
call npm install >> swl-start.log 2>&1
if errorlevel 1 goto fail
:deps_ok

if exist server\data\catalogue-items.json goto seed_ok
echo Seeding sample data...
call npm run seed >> swl-start.log 2>&1
if errorlevel 1 goto fail
:seed_ok

if exist dist\index.html goto build_ok
echo Building the application...
call npm run build >> swl-start.log 2>&1
if errorlevel 1 goto fail
:build_ok

echo Starting the server and opening your browser at http://127.0.0.1:8787
start "" http://127.0.0.1:8787
call npm run server
echo.
echo The server has stopped. Double-click start-swl.cmd to start it again.
pause
exit /b 0

:no_node
echo Node.js is not installed on this computer.
echo Install version 22 from https://nodejs.org and double-click this file again.
pause
exit /b 1

:fail
echo.
echo Something failed. The details were saved to swl-start.log in this folder.
echo Open swl-start.log and read the last lines, or send them to Claude.
pause
exit /b 1
