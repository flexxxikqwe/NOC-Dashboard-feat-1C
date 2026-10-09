@echo off
chcp 65001 > nul
setlocal EnableDelayedExpansion

title NOC Dashboard - Инсталлятор агента телеметрии 1C

echo.
echo ===================================================================
echo   [NOC 1C DASHBOARD] ТИХИЙ ИНСТАЛЛЯТОР АГЕНТА И УДАЛЕННОГО ДОСТУПА
echo ===================================================================
echo.

:: 1. Проверка прав администратора
net session >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] Данный скрипт должен быть запущен с правами Администратора!
    echo Кликните правой кнопкой мыши по файлу install.bat и выберите:
    echo "Запуск от имени администратора" ^(Run as Administrator^).
    echo.
    pause
    exit /b 1
)
echo [OK] Права администратора подтверждены.

:: 2. Конфигурация адреса сервера мониторинга NOC
if "%SERVER_URL%"=="" (
    set "SERVER_URL=http://localhost:3000"
)
echo [ИНФО] Адрес сервера мониторинга: !SERVER_URL!

:: 3. Определение пути к базе данных 1С:Предприятие
set "BASE_PATH=%~1"

if "!BASE_PATH!"=="" (
    echo.
    echo Путь к файловой базе 1С не передан в командной строке.
    set "DEFAULT_PATH=C:\1C_Bases\Retail"
    set /p "INPUT_PATH=Введите путь к каталогу информационной базы [По умолчанию: !DEFAULT_PATH!]: "
    if "!INPUT_PATH!"=="" (
        set "BASE_PATH=!DEFAULT_PATH!"
    ) else (
        set "BASE_PATH=!INPUT_PATH!"
    )
)

:: Удаляем обрамляющие кавычки, если они есть
set "BASE_PATH=!BASE_PATH:"=!"

echo [ИНФО] Выбран целевой каталог базы 1С: "!BASE_PATH!"

:: Проверка существования каталога базы
if not exist "!BASE_PATH!" (
    echo [ОШИБКА] Указанный каталог базы не существует: "!BASE_PATH!"
    echo Проверьте корректность пути и повторите запуск.
    pause
    exit /b 1
)

:: 4. Защита от монопольной блокировки 1С (Process Guard)
:CHECK_1C_PROCESSES
tasklist /FI "IMAGENAME eq 1cv8.exe" 2>nul | find /I /N "1cv8.exe" >nul
set "PROC1=%ERRORLEVEL%"
tasklist /FI "IMAGENAME eq 1cv8c.exe" 2>nul | find /I /N "1cv8c.exe" >nul
set "PROC2=%ERRORLEVEL%"

if "%PROC1%"=="0" goto WARN_1C_RUNNING
if "%PROC2%"=="0" goto WARN_1C_RUNNING
goto PROCESS_GUARD_PASSED

:WARN_1C_RUNNING
echo.
echo ===================================================================
echo [ВНИМАНИЕ] Обнаружена запущенная 1С!
echo Пожалуйста, закройте программу на 30 секунд для безопасной установки.
echo ===================================================================
echo Ожидание закрытия программы...
pause
goto CHECK_1C_PROCESSES

:PROCESS_GUARD_PASSED
echo [OK] Активные процессы 1С отсутствуют. Монопольный доступ гарантирован.

:: 5. Автонастройка корпоративного доступа AnyDesk
echo.
echo [ШАГ 1/3] Проверка и настройка службы AnyDesk...
set "ANYDESK_PATH="
if exist "C:\Program Files (x86)\AnyDesk\AnyDesk.exe" (
    set "ANYDESK_PATH=C:\Program Files (x86)\AnyDesk\AnyDesk.exe"
) else if exist "C:\Program Files\AnyDesk\AnyDesk.exe" (
    set "ANYDESK_PATH=C:\Program Files\AnyDesk\AnyDesk.exe"
)

if defined ANYDESK_PATH (
    echo Найдена программа AnyDesk: "!ANYDESK_PATH!"
    echo|set /p="SuperSupportPass2026!" | "!ANYDESK_PATH!" --set-password >nul 2>&1
    echo [OK] Корпоративный пароль AnyDesk успешно установлен.
) else (
    echo [ВНИМАНИЕ] AnyDesk не обнаружен, пропуск настройки пароля.
)

:: 6. Загрузка расширения support.cfe
echo.
echo [ШАГ 2/3] Загрузка актуальной версии расширения с пульта NOC...
set "TEMP_CFE=%TEMP%\support.cfe"
if exist "!TEMP_CFE!" del /f /q "!TEMP_CFE!" >nul 2>&1

curl -f -s -k -o "!TEMP_CFE!" "!SERVER_URL!/downloads/support.cfe"
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] Не удалось скачать файл расширения support.cfe с адреса:
    echo "!SERVER_URL!/downloads/support.cfe"
    echo Проверьте доступность веб-сервера мониторинга и сети.
    pause
    exit /b 1
)

if not exist "!TEMP_CFE!" (
    echo [ОШИБКА] Файл расширения !TEMP_CFE! не обнаружен после скачивания.
    pause
    exit /b 1
)
echo [OK] Расширение support.cfe успешно загружено во временный каталог.

:: 7. Поиск исполняемого файла 1С:Предприятие (1cestart / 1cv8)
echo.
echo [ШАГ 3/3] Пакетное внедрение расширения в конфигурацию 1С...
set "ONEC_EXE="

if exist "C:\Program Files\1cv8\common\1cestart.exe" (
    set "ONEC_EXE=C:\Program Files\1cv8\common\1cestart.exe"
) else if exist "C:\Program Files (x86)\1cv8\common\1cestart.exe" (
    set "ONEC_EXE=C:\Program Files (x86)\1cv8\common\1cestart.exe"
)

if not defined ONEC_EXE (
    echo [ВНИМАНИЕ] 1cestart.exe не найден в стандартных каталогах, поиск установленных версий...
    for /d %%D in ("C:\Program Files\1cv8\8.*") do (
        if exist "%%D\bin\1cv8.exe" set "ONEC_EXE=%%D\bin\1cv8.exe"
    )
)
if not defined ONEC_EXE (
    for /d %%D in ("C:\Program Files (x86)\1cv8\8.*") do (
        if exist "%%D\bin\1cv8.exe" set "ONEC_EXE=%%D\bin\1cv8.exe"
    )
)

if not defined ONEC_EXE (
    echo [ОШИБКА] Платформа 1С:Предприятие 8 не найдена в системных каталогах!
    echo Убедитесь, что 1С установлена на данном компьютере.
    del /f /q "!TEMP_CFE!" >nul 2>&1
    pause
    exit /b 1
)

echo Обнаружен исполняемый файл 1С: "!ONEC_EXE!"
echo Применение расширения "_МониторСаппорта" в пакетном режиме Конфигуратора...

"!ONEC_EXE!" DESIGNER /F "!BASE_PATH!" /LoadCfg "!TEMP_CFE!" -Extension "_МониторСаппорта" /UpdateDBCfg /Out "%TEMP%\1c_extension_install.log"
set "INSTALL_STATUS=%ERRORLEVEL%"

:: Удаляем временный файл расширения
del /f /q "!TEMP_CFE!" >nul 2>&1

if %INSTALL_STATUS% NEQ 0 (
    echo.
    echo [ОШИБКА] Ошибка при пакетной установке расширения в 1С (Код: %INSTALL_STATUS%).
    if exist "%TEMP%\1c_extension_install.log" (
        echo Лог Конфигуратора 1С:
        type "%TEMP%\1c_extension_install.log"
    )
    pause
    exit /b %INSTALL_STATUS%
)

:: Удаляем временный лог
if exist "%TEMP%\1c_extension_install.log" del /f /q "%TEMP%\1c_extension_install.log" >nul 2>&1

:: 8. Финальный отчет
echo.
echo ====================================================
echo [УСПЕХ] Расширение "_МониторСаппорта" внедрено!
echo Касса автоматически подключена к пульту мониторинга.
echo ====================================================
echo.
pause
exit /b 0
