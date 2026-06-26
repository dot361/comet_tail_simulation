@echo off
setlocal
cd /d "%~dp0"

if not exist "..\index.html" (
  echo ERROR: ..\index.html not found.
  echo This BAT file must stay inside comet_tail_simulation\benchmark.
  pause
  exit /b 1
)

if not exist "run_benchmark.py" (
  echo ERROR: run_benchmark.py not found.
  pause
  exit /b 1
)

echo.
echo Installing/checking required Python packages...
python -c "import playwright, pandas, matplotlib" 2>nul
if errorlevel 1 (
  python -m pip install playwright pandas matplotlib
)

echo.
echo Installing/checking Playwright Chrome...
python -m playwright install chrome

echo.
echo Running benchmark. Each particle count is measured 5 times.
echo Keep the browser window visible. Do NOT minimize it.
echo.

python run_benchmark.py

echo.
echo Finished. Results are inside:
echo   %CD%\results_%COMPUTERNAME%
echo.
pause
