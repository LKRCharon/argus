@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Open-Codex-Web.ps1" %*
if errorlevel 1 pause
