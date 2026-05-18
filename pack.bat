@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

echo ========================================
echo   chat-audit Pack (PyInstaller)
echo ========================================
echo.

set "SKIP_INSTALL=0"
set "CLEAN_ONLY=0"
set "VERBOSE=0"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--skip-install" set "SKIP_INSTALL=1" & shift & goto :parse_args
if /i "%~1"=="--clean" set "CLEAN_ONLY=1" & shift & goto :parse_args
if /i "%~1"=="-v" set "VERBOSE=1" & shift & goto :parse_args
if /i "%~1"=="--verbose" set "VERBOSE=1" & shift & goto :parse_args
echo [WARN] Unknown arg: %~1
shift
goto :parse_args

:args_done
if "%CLEAN_ONLY%"=="1" (
    echo [CLEAN] Cleaning dist and build directories...
    if exist "dist" rmdir /s /q "dist" 2>nul
    if exist "build" rmdir /s /q "build" 2>nul
    echo [OK] Clean completed.
    goto :end_ok
)

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] python not found. Install Python and add it to PATH.
    goto :end_fail
)

echo Checking Python version...
python -c "import sys; sys.exit(0 if sys.version_info>=(3,8) else 1)"
if errorlevel 1 (
    echo [ERROR] Python 3.8+ required. Current:
    python --version
    goto :end_fail
)
echo [OK] Python version OK

if "%SKIP_INSTALL%"=="0" (
    echo.
    echo [1/3] Installing dependencies...
    set "PYTHONUNBUFFERED=1"
    python -m pip install -r requirements.txt pyinstaller --disable-pip-version-check -q
    if errorlevel 1 (
        echo [ERROR] pip install failed.
        goto :end_fail
    )
    echo [OK] Dependencies installed
)

echo.
echo Checking required packages...
python -c "import websockets; import keyring; import cryptography" 2>nul
if errorlevel 1 (
    echo [WARN] Some packages may be missing. Run without --skip-install to reinstall.
)

echo.
echo [2/3] Preparing dist directory...
echo    Stopping running app (if open)...
taskkill /F /IM chat-audit-export.exe >nul 2>&1
timeout /t 1 /nobreak >nul

if exist "dist\chat-audit-export" (
    echo    Removing old dist...
    rmdir /s /q "dist\chat-audit-export" 2>nul
)
if exist "build" (
    echo    Removing old build...
    rmdir /s /q "build" 2>nul
)

if exist "dist\chat-audit-export.exe.old" del /f /q "dist\chat-audit-export.exe.old" 2>nul
if exist "dist\chat-audit-export.exe" del /f /q "dist\chat-audit-export.exe" 2>nul

echo    Ready for build.

echo.
echo [3/3] Running PyInstaller...
if "%VERBOSE%"=="1" (
    pyinstaller --clean build.spec
) else (
    pyinstaller --clean build.spec --log-level ERROR
)
if errorlevel 1 (
    echo.
    echo [ERROR] PyInstaller failed. Check output above or run with -v for details.
    goto :end_fail
)

set "OUTEXE=%cd%\dist\chat-audit-export\chat-audit-export.exe"
if not exist "%OUTEXE%" (
    echo [ERROR] Expected output not found: %OUTEXE%
    goto :end_fail
)

echo.
echo Verifying build output...
if not exist "dist\chat-audit-export\_internal\scripts\crm-check.js" (
    echo [ERROR] Critical file missing: crm-check.js
    goto :end_fail
)
echo [OK] Build verified

echo.
echo ========================================
echo [OK] Build successful!
echo ========================================
echo Output: %OUTEXE%
echo.
echo Running from source: python run.py
echo.
start "" explorer /select,"%OUTEXE%" 2>nul
goto :end_ok

:end_fail
echo.
echo ========================================
echo [FAIL] Build failed. See errors above.
echo ========================================
echo Tip: Run pack.bat -v for verbose output
echo.
echo Press any key to close...
pause
exit /b 1

:end_ok
echo Press any key to close...
pause
exit /b 0