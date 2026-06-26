@echo off
cd /d "%~dp0"
python create_contour_comparison.py --draw-cleanup
pause
