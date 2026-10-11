@echo off
rem Opens the Earner dashboard in your browser. Close this window to stop it.
cd /d "%~dp0"
set PYTHONUTF8=1
".venv\Scripts\python.exe" -m earner ui
