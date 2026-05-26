@echo off
cd /d "%~dp0"

set "PORT=8765"

for /f "tokens=5" %%a in ('netstat -ano ^| findstr "127.0.0.1:%PORT%" ^| findstr "LISTENING"') do (
  if not "%%a"=="0" (
    echo Port %PORT% in use, stopping PID %%a ...
    taskkill /F /PID %%a >nul 2>&1
  )
)

echo.
echo MMFC Rating Analysis Lab
echo http://127.0.0.1:%PORT%/
echo Press Ctrl+C to stop the server
echo.

start "" "http://127.0.0.1:%PORT%/"

where py >nul 2>&1
if errorlevel 1 goto use_python
py -m http.server %PORT% --bind 127.0.0.1
goto done

:use_python
python -m http.server %PORT% --bind 127.0.0.1

:done
if errorlevel 1 (
  echo.
  echo Failed to start. Install Python 3 and ensure py or python is in PATH.
  pause
)
