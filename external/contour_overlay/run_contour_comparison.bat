@echo off
setlocal
cd /d "%~dp0"
python create_contour_comparison.py
echo.
echo The comparison window will remain open so you can read the Jaccard score.
pause
