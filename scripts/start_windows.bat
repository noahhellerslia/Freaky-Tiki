@echo off
REM Freaky Tiki playtest (Windows): starts the game server in one window and
REM a Cloudflare quick tunnel in this one. Double-click me, send friends the
REM trycloudflare link it prints, keep both windows open while you play.
cd /d "%~dp0.."

where py >nul 2>nul && (set PY=py) || (set PY=python)
%PY% --version >nul 2>nul || (
  echo Python 3 was not found. Install it from python.org and run me again.
  echo IMPORTANT: tick "Add python.exe to PATH" during install.
  pause & exit /b 1
)

if not exist ".venv\Scripts\uvicorn.exe" (
  echo First-run setup: creating virtualenv and installing dependencies...
  %PY% -m venv .venv
  .venv\Scripts\pip install -q -r requirements.txt
)
if not exist "tools\cloudflared.exe" (
  echo Downloading cloudflared - the tunnel tool...
  mkdir tools 2>nul
  set "CF_DL=https://github.com/cloudflare/cloudflared/releases/latest/download/"
  powershell -Command "Invoke-WebRequest -Uri '%CF_DL%cloudflared-windows-amd64.exe' -OutFile 'tools\cloudflared.exe'"
)

echo Starting the game server in a new window...
start "Freaky Tiki server - keep open" cmd /k "cd /d %CD%\server && ..\.venv\Scripts\uvicorn server:app --host 0.0.0.0 --port 8000"
timeout /t 3 >nul

echo Opening the tunnel - look for the trycloudflare.com link below.
echo Send that link to your friends; everyone joins with the same room code.
echo.
tools\cloudflared.exe tunnel --url http://127.0.0.1:8000 --no-autoupdate
pause
