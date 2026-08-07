@echo off
REM Jarvis - one-click setup. Double-click this file, or run: setup.bat
REM The window stays open at the end no matter what happens, so you can
REM always read the error instead of watching it flash and vanish.

cd /d "%~dp0"
echo ==============================================================
echo   JARVIS - setup
echo ==============================================================
echo.

REM --- find a Python that PyAudio actually has a wheel for -------------------
set "PYEXE="
for %%V in (3.12 3.13 3.11) do (
    if not defined PYEXE (
        py -%%V -c "import sys" >nul 2>&1 && set "PYEXE=py -%%V"
    )
)

if not defined PYEXE (
    echo   [FAIL] No Python 3.11, 3.12 or 3.13 found.
    echo.
    echo   Install Python 3.12 from:
    echo     https://www.python.org/downloads/release/python-3129/
    echo   Pick "Windows installer (64-bit)".
    echo   TICK "Add python.exe to PATH" on the first installer screen.
    echo.
    echo   Then run this file again.
    goto :done
)

echo   Using: %PYEXE%
echo.

REM --- virtual environment ---------------------------------------------------
if exist ".venv\Scripts\python.exe" (
    echo   [1/3] Virtual environment already exists - reusing it.
) else (
    echo   [1/3] Creating virtual environment...
    %PYEXE% -m venv .venv
    if errorlevel 1 (
        echo   [FAIL] Could not create the virtual environment.
        goto :done
    )
)

REM Call the venv's python directly rather than "activate" - activate only
REM affects the shell it runs in, and inside a .bat that gets fragile.
set "VPY=.venv\Scripts\python.exe"

echo   [2/3] Installing packages ^(this takes a few minutes the first time^)...
"%VPY%" -m pip install --upgrade pip --quiet
"%VPY%" -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo   [FAIL] Install failed. Scroll up to the first red error.
    echo   If it mentions PyAudio or portaudio.h, your Python is too new -
    echo   install 3.12 and run this file again.
    goto :done
)

echo.
echo   [3/3] Checking the setup...
echo.
"%VPY%" check_setup.py

echo.
echo ==============================================================
echo   Next: copy .env.example to .env and paste your Anthropic key
echo   into it. Then run:  .venv\Scripts\activate
echo ==============================================================

:done
echo.
pause
