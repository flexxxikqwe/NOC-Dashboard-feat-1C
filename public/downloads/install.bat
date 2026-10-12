@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 > nul
title Установка расширения NOC 1C

echo ====================================================
echo   Установка расширения мониторинга саппорта в 1С
echo ====================================================
echo.

:: 1. Проверка прав администратора
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ОШИБКА] Запустите скрипт установки от имени Администратора!
    echo         Щелкните правой кнопкой мыши по install.bat и выберите
    echo         "Запуск от имени администратора".
    echo.
    pause
    exit /b 1
)

:: 2. Определение пути к информационной базе 1С
set "BASE_PATH=%~1"
if "%BASE_PATH%"=="" (
    set /p "BASE_PATH=Введите полный путь к папке с файловой базой 1С: "
)

:: Безопасная очистка возможных внешних кавычек из интерактивного ввода
if defined BASE_PATH (
    for /f "tokens=*" %%I in ("%BASE_PATH%") do set "BASE_PATH=%%~I"
)

if "%BASE_PATH%"=="" (
    echo [ОШИБКА] Путь к информационной базе 1С не указан!
    echo.
    pause
    exit /b 1
)

if not exist "%BASE_PATH%" (
    echo [ОШИБКА] Каталог информационной базы не существует:
    echo          "%BASE_PATH%"
    echo.
    pause
    exit /b 1
)

echo [ИНФО] Выбрана информационная база: "%BASE_PATH%"

:: 3. Определение параметров сервера мониторинга и токена авторизации кассы
:: Поддержка синтаксиса:
:: install.bat "<ПутьКБазе>" "<NOC_SERVER_URL>" "<ARG_DEVICE_TOKEN>"
:: либо install.bat "<ПутьКБазе>" "<ARG_DEVICE_TOKEN>" (если второй аргумент - токен)
set "SERVER_URL=%~2"
set "ARG_DEVICE_TOKEN=%~3"

:: Если во втором аргументе передан токен (не URL с http/https) и третий пуст:
if not "%SERVER_URL%"=="" if "%ARG_DEVICE_TOKEN%"=="" (
    echo "%SERVER_URL%" | findstr /i /r "^\"https:// ^\"http://" >nul
    if errorlevel 1 (
        set "ARG_DEVICE_TOKEN=%SERVER_URL%"
        set "SERVER_URL="
    )
)

if "%SERVER_URL%"=="" if defined NOC_SERVER_URL set "SERVER_URL=%NOC_SERVER_URL%"
if "%SERVER_URL%"=="" set "SERVER_URL=http://localhost:3000"

:: Удаление завершающего слэша, если указан
if "%SERVER_URL:~-1%"=="/" set "SERVER_URL=%SERVER_URL:~0,-1%"

:: Проверка наличия токена в аргументах или переменных среды
set "NOC_DEVICE_TOKEN="
if defined ARG_DEVICE_TOKEN set "NOC_DEVICE_TOKEN=%ARG_DEVICE_TOKEN%"
if "%NOC_DEVICE_TOKEN%"=="" if defined NOC_TOKEN set "NOC_DEVICE_TOKEN=%NOC_TOKEN%"

:: 4. Безопасное сохранение конфигурации в %ProgramData%\1C-NOC с защитой ACL (icacls)
set "NOC_DIR=%ProgramData%\1C-NOC"
if not exist "%NOC_DIR%" mkdir "%NOC_DIR%" >nul 2>&1

:: Ограничение прав доступа к каталогу 1C-NOC: только Администраторы и SYSTEM
icacls "%NOC_DIR%" /inheritance:r /grant:r "Administrators":(OI)(CI)F /grant:r "SYSTEM":(OI)(CI)F >nul 2>&1

:: Если токен передан, записываем безопасный config.json
if defined NOC_DEVICE_TOKEN (
    (
        echo {
        echo   "server_url": "%SERVER_URL%",
        echo   "token": "%NOC_DEVICE_TOKEN%"
        echo }
    ) > "%NOC_DIR%\config.json"
    icacls "%NOC_DIR%\config.json" /inheritance:r /grant:r "Administrators":F /grant:r "SYSTEM":F >nul 2>&1
    echo [ИНФО] Конфигурация токена кассы сохранена в "%NOC_DIR%\config.json" с защитой ACL.
) else (
    (
        echo {
        echo   "server_url": "%SERVER_URL%"
        echo }
    ) > "%NOC_DIR%\config.json"
    icacls "%NOC_DIR%\config.json" /inheritance:r /grant:r "Administrators":F /grant:r "SYSTEM":F >nul 2>&1
    echo [ИНФО] Токен устройства не указан. Задайте NOC_TOKEN в среде или через %NOC_DIR%\config.json.
)

:: 5. Обнаружение клиентов удаленного доступа (AnyDesk / RuDesktop)
:: ПРИНЦИП БЕЗОПАСНОСТИ: Пароли не задаются и не сохраняются в скриптах!
:: Идентификатор (ID) определяется расширением 1С динамически из конфигурационных файлов.
set "REMOTE_DETECTED=0"

set "ANYDESK_EXE="
if exist "%ProgramFiles(x86)%\AnyDesk\AnyDesk.exe" set "ANYDESK_EXE=%ProgramFiles(x86)%\AnyDesk\AnyDesk.exe"
if exist "%ProgramFiles%\AnyDesk\AnyDesk.exe" set "ANYDESK_EXE=%ProgramFiles%\AnyDesk\AnyDesk.exe"

set "ANYDESK_CONF="
if exist "%ProgramData%\AnyDesk\system.conf" set "ANYDESK_CONF=%ProgramData%\AnyDesk\system.conf"

set "RUDESKTOP_EXE="
if exist "%ProgramFiles%\RuDesktop\rudesktop.exe" set "RUDESKTOP_EXE=%ProgramFiles%\RuDesktop\rudesktop.exe"
if exist "%ProgramFiles(x86)%\RuDesktop\rudesktop.exe" set "RUDESKTOP_EXE=%ProgramFiles(x86)%\RuDesktop\rudesktop.exe"

set "RUDESKTOP_CONF="
if exist "%ProgramData%\RuDesktop\rudesktop.cfg" set "RUDESKTOP_CONF=%ProgramData%\RuDesktop\rudesktop.cfg"

if not "%ANYDESK_EXE%"=="" (
    set "REMOTE_DETECTED=1"
    echo [1/3] Обнаружен клиент AnyDesk: "%ANYDESK_EXE%"
    if not "%ANYDESK_CONF%"=="" (
        echo       Файл system.conf найден. ID будет считываться динамически.
    ) else (
        echo       [ПРЕДУПРЕЖДЕНИЕ] system.conf пока отсутствует (требуется первый запуск AnyDesk).
    )
)

if not "%RUDESKTOP_EXE%"=="" (
    set "REMOTE_DETECTED=1"
    echo [1/3] Обнаружен клиент RuDesktop: "%RUDESKTOP_EXE%"
    if not "%RUDESKTOP_CONF%"=="" (
        echo       Файл rudesktop.cfg найден. ID будет считываться динамически.
    )
)

if "%REMOTE_DETECTED%"=="0" (
    echo [1/3] [ПРЕДУПРЕЖДЕНИЕ] Клиенты AnyDesk и RuDesktop не обнаружены.
    echo       Мониторинг 1С продолжит работу в штатном режиме, но для
    echo       удаленного подключения потребуется установить ПО поддержки.
)

:: 6. Загрузка расширения support.cfe
set "CFE_URL=%SERVER_URL%/downloads/support.cfe"
set "TEMP_CFE=%TEMP%\support_%RANDOM%_%TIME:~6,2%.cfe"
if exist "%TEMP_CFE%" del /f /q "%TEMP_CFE%" >nul 2>&1

echo [2/3] Загрузка артефакта расширения: %CFE_URL%...

where curl >nul 2>&1
if %errorlevel% equ 0 (
    curl -f -k -s -S -o "%TEMP_CFE%" "%CFE_URL%"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('%CFE_URL%', '%TEMP_CFE%')" >nul 2>&1
)

if not exist "%TEMP_CFE%" (
    echo [ОШИБКА] Не удалось загрузить support.cfe по адресу:
    echo          %CFE_URL%
    echo          Проверьте доступность сервера и параметры сети.
    goto cleanup_and_exit_fail
)

:: Проверка ненулевого размера файла
for %%A in ("%TEMP_CFE%") do if %%~zA equ 0 (
    echo [ОШИБКА] Загруженный файл support.cfe имеет нулевой размер!
    del /f /q "%TEMP_CFE%" >nul 2>&1
    goto cleanup_and_exit_fail
)

echo [OK] Файл support.cfe успешно загружен во временный каталог.

:: 7. Поиск исполняемого файла 1С:Предприятие
set "ONEC_EXE="
if exist "%ProgramFiles%\1cv8\common\1cestart.exe" set "ONEC_EXE=%ProgramFiles%\1cv8\common\1cestart.exe"
if exist "%ProgramFiles(x86)%\1cv8\common\1cestart.exe" set "ONEC_EXE=%ProgramFiles(x86)%\1cv8\common\1cestart.exe"

if "%ONEC_EXE%"=="" (
    echo [ОШИБКА] Не найден 1cestart.exe в стандартных каталогах!
    echo          Убедитесь, что платформа 1С:Предприятие 8.3 установлена на этом компьютере.
    goto cleanup_and_exit_fail
)

echo [ИНФО] Обнаружен стартер 1С: "%ONEC_EXE%"

:: 8. Пакетная посадка расширения в информационную базу
echo [3/3] Внедрение расширения "_МониторСаппорта" в базу 1С...
echo       (Выполняется обновление конфигурации, пожалуйста, подождите)...

start /wait "" "%ONEC_EXE%" DESIGNER /F "%BASE_PATH%" /LoadCfg "%TEMP_CFE%" -Extension "_МониторСаппорта" /UpdateDBCfg
set "ONEC_EXIT_CODE=%errorlevel%"

:: Гарантированная очистка временного файла
if exist "%TEMP_CFE%" del /f /q "%TEMP_CFE%" >nul 2>&1

if %ONEC_EXIT_CODE% neq 0 (
    echo [ОШИБКА] Конфигуратор 1С завершился с кодом ошибки %ONEC_EXIT_CODE%!
    echo          Возможные причины:
    echo          - База 1С открыта кассиром монопольно (закройте 1С перед установкой);
    echo          - Недостаточно прав на запись в каталог информационной базы;
    echo          - Неверно указан путь к базе данных.
    goto cleanup_and_exit_fail
)

echo.
echo ====================================================
echo [УСПЕХ] Расширение "_МониторСаппорта" успешно внедрено!
echo.
echo  - Идентификатор AnyDesk/RuDesktop будет определен
echo    динамически при первом входе в 1С.
echo  - Статические пароли не сохранялись.
echo  - Конфигурация защищена NTFS ACL (Administrators/SYSTEM).
echo  - Опрос телеметрии начнется автоматически.
echo ====================================================
echo.

:: 9. Безопасная очистка переменных секретов из памяти процесса перед выходом
set "ARG_DEVICE_TOKEN="
set "NOC_DEVICE_TOKEN="
pause
exit /b 0

:cleanup_and_exit_fail
if exist "%TEMP_CFE%" del /f /q "%TEMP_CFE%" >nul 2>&1
set "ARG_DEVICE_TOKEN="
set "NOC_DEVICE_TOKEN="
echo.
pause
exit /b 1