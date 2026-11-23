@echo off
REM Windows entry for the heinote script beside this file.
REM The script has no extension, so Windows cannot start it as a program.
REM -X utf8 keeps the output UTF-8 whatever code page the console uses.
REM Keep this file ASCII only: cmd.exe reads a batch in the OEM code page,
REM so non-ASCII text here breaks the parser.
setlocal
where python >nul 2>nul
if %ERRORLEVEL%==0 goto run_python
where py >nul 2>nul
if %ERRORLEVEL%==0 goto run_py
echo heinote: Python 3 not found on PATH (install python, or the py launcher). 1>&2
exit /b 1

:run_python
python -X utf8 "%~dp0heinote" %*
exit /b %ERRORLEVEL%

:run_py
py -3 -X utf8 "%~dp0heinote" %*
exit /b %ERRORLEVEL%