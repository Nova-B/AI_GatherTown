@echo off
setlocal
rem Agent Town launcher (Windows). Builds on first run, then starts the local
rem server on http://127.0.0.1:4317 (or the next free port) and opens the browser.
set "TOWN=%~dp0town"
if not exist "%TOWN%\package.json" (
  echo [Agent Town] town\package.json not found next to this script.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo [Agent Town] Node.js 22.13 or newer is required ^(node not found in PATH^).
  pause
  exit /b 1
)
pushd "%TOWN%"
if not exist "node_modules" (
  echo [Agent Town] Installing dependencies...
  call npm install --no-audit --no-fund --legacy-peer-deps
  if errorlevel 1 ( popd & pause & exit /b 1 )
)
if not exist "dist\server\index.js" (
  echo [Agent Town] Building...
  call npm run build
  if errorlevel 1 ( popd & pause & exit /b 1 )
)
echo [Agent Town] Starting server. Close this window to stop.
set "AGENT_TOWN_OPEN=1"
node --no-warnings=ExperimentalWarning dist\server\index.js
popd
endlocal
