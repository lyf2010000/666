@echo off
rem Windows cmd wrapper for detect-easyeda-cli.ps1
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0detect-easyeda-cli.ps1" %*
exit /b %ERRORLEVEL%
