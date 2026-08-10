@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-validation.ps1" %*
exit /b %ERRORLEVEL%
