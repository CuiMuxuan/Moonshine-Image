@echo off
setlocal
chcp 65001 >nul 2>&1
title Moonshine-Image Test Validator

set "VALIDATOR_ROOT=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%VALIDATOR_ROOT%Run-Moonshine-Image-Test-Validator.ps1"
set "VALIDATOR_EXIT=%ERRORLEVEL%"

echo.
if "%VALIDATOR_EXIT%"=="0" (
  echo Validation finished. Send the generated ZIP report to the Moonshine-Image developer.
) else (
  echo Validation found a problem. Send the generated ZIP report to the Moonshine-Image developer.
)
echo.
pause
exit /b %VALIDATOR_EXIT%
