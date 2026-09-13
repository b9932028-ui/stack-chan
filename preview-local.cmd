@echo off
setlocal

REM Builds the Stack-chan web console and serves the production bundle.
REM Use this to verify a release build; use start-local.cmd for day-to-day work.
REM Press Ctrl+C to stop.

cd /d "E:\MicroChan\stack-chan\web"
if errorlevel 1 (
  echo Could not open E:\MicroChan\stack-chan\web
  pause
  exit /b 1
)

if not exist package.json (
  echo package.json was not found in E:\MicroChan\stack-chan\web
  pause
  exit /b 1
)

npm run build
if errorlevel 1 (
  echo.
  echo Build failed - not starting the preview server.
  pause
  exit /b 1
)

npm run preview -- --host 127.0.0.1 --configLoader runner --port 5173 --strictPort
if errorlevel 1 (
  echo.
  echo Server exited with an error.
  echo If port 5173 is already in use, a server is probably still running:
  echo   - switch to its window and press Ctrl+C, or
  echo   - run: npx kill-port 5173
  pause
)

endlocal
