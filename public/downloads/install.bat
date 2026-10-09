@echo off
chcp 65001 > nul
title Установка расширения NOC 1C

echo ====================================================
echo   Установка мониторинга саппорта в 1С
echo ====================================================

:: 1. Проверка прав администратора
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ОШИБКА] Запустите батник от имени Администратора!
    pause
    exit /b 1
)

:: 2. Путь к базе данных
set "BASE_PATH=%~1"
if "%BASE_PATH%"=="" (
    set /p "BASE_PATH=Введите полный путь к папке с базой 1С: "
)

echo [ИНФО] Выбрана база: %BASE_PATH%

:: 3. Настройка AnyDesk
set "ANYDESK_PATH="
if exist "C:\Program Files (x86)\AnyDesk\AnyDesk.exe" set "ANYDESK_PATH=C:\Program Files (x86)\AnyDesk\AnyDesk.exe"
if exist "C:\Program Files\AnyDesk\AnyDesk.exe" set "ANYDESK_PATH=C:\Program Files\AnyDesk\AnyDesk.exe"

if "%ANYDESK_PATH%"=="" goto skip_anydesk
echo [1/3] Настройка AnyDesk пароля...
echo|set /p="SuperSupportPass2026!" | "%ANYDESK_PATH%" --set-password
echo [OK] Пароль AnyDesk установлен.
goto after_anydesk

:skip_anydesk
echo [1/3] AnyDesk не обнаружен, пропуск настройки пароля.

:after_anydesk

:: 4. Скачивание расширения
echo [2/3] Скачивание support.cfe с сервера...
set "TEMP_CFE=%TEMP%\support.cfe"
if exist "%TEMP_CFE%" del /f /q "%TEMP_CFE%"

curl -f -k -o "%TEMP_CFE%" "http://localhost:3000/downloads/support.cfe"

if not exist "%TEMP_CFE%" (
    echo [ОШИБКА] Не удалось скачать файл support.cfe!
    echo Проверьте, что в терминале работает "npm run dev".
    pause
    exit /b 1
)
echo [OK] Файл support.cfe успешно скачан во временную папку.

:: 5. Поиск 1С
set "ONEC_EXE="
if exist "C:\Program Files\1cv8\common\1cestart.exe" set "ONEC_EXE=C:\Program Files\1cv8\common\1cestart.exe"
if exist "C:\Program Files (x86)\1cv8\common\1cestart.exe" set "ONEC_EXE=C:\Program Files (x86)\1cv8\common\1cestart.exe"

if "%ONEC_EXE%"=="" (
    echo [ОШИБКА] Не найден файл 1cestart.exe!
    pause
    exit /b 1
)

:: 6. Пакетная посадка расширения
echo [3/3] Внедрение расширения в 1С (ждите 10-15 секунд)...
start /wait "" "%ONEC_EXE%" DESIGNER /F "%BASE_PATH%" /LoadCfg "%TEMP_CFE%" -Extension "_МониторСаппорта" /UpdateDBCfg


echo.
echo ====================================================
echo [УСПЕХ] Расширение "_МониторСаппорта" внедрено в базу!
echo ====================================================
echo.
pause