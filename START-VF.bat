@echo off
chcp 65001 >nul
title Velvet Factory — setup
echo.
echo ========================================
echo   Velvet Factory — התקנה פשוטה
echo ========================================
echo.

where git >nul 2>&1
if errorlevel 1 (
    echo [X] Git לא מותקן.
    echo     הורד מ: https://git-scm.com/download/win
    echo     התקן ואז הרץ שוב את הקובץ הזה.
    pause
    exit /b 1
)

set "VF_DIR=%~dp0"
set "VF_DIR=%VF_DIR:~0,-1%"
cd /d "%VF_DIR%"

echo [1/2] מושך VelvetOS Core ל-vendor/ ...
set "BASH="
if exist "C:\Program Files\Git\bin\bash.exe" set "BASH=C:\Program Files\Git\bin\bash.exe"
if exist "C:\Program Files (x86)\Git\bin\bash.exe" set "BASH=C:\Program Files (x86)\Git\bin\bash.exe"

if defined BASH (
    "%BASH%" -lc "cd '%VF_DIR%' && ./scripts/attach-core.sh"
    if errorlevel 1 (
        echo [X] attach-core נכשל — נסה Git Bash ידנית.
        goto show_path
    )
    echo [OK] Core מחובר.
) else (
    echo [!] Git Bash לא נמצא — דלג על attach-core.
    echo     פתח Git Bash והרץ: ./scripts/attach-core.sh
)

:show_path
echo.
echo [2/2] פתח ב-Cursor את התיקייה:
echo.
echo   %VF_DIR%
echo.
echo File ^> Open Folder ^> בחר את הנתיב למעלה
echo.
echo ========================================
pause
