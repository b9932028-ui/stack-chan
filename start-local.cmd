@echo off
setlocal

REM Local development server for the Stack-chan web console.
REM Serves source directly with hot reload - no build step needed.
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

npm run dev -- --host 127.0.0.1 --configLoader runner --port 5173 --strictPort
if errorlevel 1 (
  echo.
  echo Server exited with an error.
  echo If port 5173 is already in use, a server is probably still running:
  echo   - switch to its window and press Ctrl+C, or
  echo   - run: npx kill-port 5173
  pause
)

endlocal
