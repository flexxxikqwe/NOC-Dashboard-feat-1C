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

:: Если во втором аргументе передан токен (не URL с http/https) и третий аргумент пуст
if not "%SERVER_URL%"=="" if "%ARG_DEVICE_TOKEN%"=="" (
    echo "%SERVER_URL%" | findstr /i /r "^\"https:// ^\"http://" >nul
    if errorlevel 1 (
        set "ARG_DEVICE_TOKEN=%SERVER_URL%"
        set "SERVER_URL="
    )
)

:: Приоритет переменной среды NOC_SERVER_URL над незаданным аргументом
if "%SERVER_URL%"=="" if defined NOC_SERVER_URL set "SERVER_URL=%NOC_SERVER_URL%"

:: Если URL все еще пуст, запросить интерактивно
if "%SERVER_URL%"=="" (
    set /p "SERVER_URL=Введите URL сервера мониторинга NOC (например, https://noc.company.local:3000): "
)

:: Очистка кавычек из SERVER_URL
if defined SERVER_URL (
    for /f "tokens=*" %%I in ("%SERVER_URL%") do set "SERVER_URL=%%~I"
)

:: Исключение скрытого дефолта на localhost: URL сервера обязателен
if "%SERVER_URL%"=="" (
    echo [ОШИБКА] URL сервера мониторинга не указан!
    echo          Укажите адрес сервера через параметр командной строки,
    echo          переменную NOC_SERVER_URL или интерактивный ввод.
    echo          Автоматический fallback на localhost отключен политикой безопасности.
    goto cleanup_and_exit_fail
)

:: Удаление завершающего слэша, если указан
if "%SERVER_URL:~-1%"=="/" set "SERVER_URL=%SERVER_URL:~0,-1%"

:: Проверка протокола: HTTPS обязателен для удаленных серверов
echo "%SERVER_URL%" | findstr /i /r "^\"https://" >nul
if %errorlevel% equ 0 (
    echo [ИНФО] Протокол защищенного подключения: HTTPS
) else (
    echo "%SERVER_URL%" | findstr /i /r "^\"http://" >nul
    if %errorlevel% equ 0 (
        :: Проверка локального dev-окружения (localhost / 127.0.0.1 или явный флаг NOC_DEV_MODE)
        set "IS_LOCAL_DEV=0"
        echo "%SERVER_URL%" | findstr /i "://localhost ://127.0.0.1" >nul
        if %errorlevel% equ 0 set "IS_LOCAL_DEV=1"
        if "%NOC_DEV_MODE%"=="1" set "IS_LOCAL_DEV=1"
        if "%ALLOW_INSECURE_HTTP%"=="1" set "IS_LOCAL_DEV=1"

        if "%IS_LOCAL_DEV%"=="1" (
            echo [ПРЕДУПРЕЖДЕНИЕ] Использование незащищенного HTTP разрешено только для локального dev-окружения (%SERVER_URL%).
        ) else (
            echo [ОШИБКА] Недопустимый протокол подключения: "%SERVER_URL%"!
            echo          Для удаленных серверов требуется протокол HTTPS (https://...).
            echo          Незащищенный HTTP в production запрещен политикой безопасности.
            goto cleanup_and_exit_fail
        )
    ) else (
        echo [ОШИБКА] Некорректный формат URL сервера мониторинга: "%SERVER_URL%".
        echo          URL должен начинаться с https:// (или http://localhost для локального тестирования).
        goto cleanup_and_exit_fail
    )
)

:: 4. Определение токена авторизации (интерактивный ввод, аргумент или существующий конфиг)
set "NOC_DIR=%ProgramData%\1C-NOC"
set "CONFIG_PATH=%NOC_DIR%\config.json"
set "NOC_DEVICE_TOKEN="

if defined ARG_DEVICE_TOKEN (
    set "NOC_DEVICE_TOKEN=%ARG_DEVICE_TOKEN%"
    echo [ПРЕДУПРЕЖДЕНИЕ] Токен передан через аргумент командной строки.
    echo                 Для предотвращения утечек в списке процессов рекомендуется интерактивный ввод.
)
if "%NOC_DEVICE_TOKEN%"=="" if defined NOC_TOKEN set "NOC_DEVICE_TOKEN=%NOC_TOKEN%"

:: Если токен не передан, проверяем наличие существующего в %ProgramData%\1C-NOC\config.json
set "EXISTING_TOKEN="
if exist "%CONFIG_PATH%" (
    for /f "usebackq tokens=*" %%T in (`powershell -NoProfile -Command "try { (Get-Content -Raw '%CONFIG_PATH%' | ConvertFrom-Json).token } catch {}" 2^>nul`) do (
        if not "%%~T"=="" set "EXISTING_TOKEN=%%~T"
    )
)

if "%NOC_DEVICE_TOKEN%"=="" if not "%EXISTING_TOKEN%"=="" (
    set "NOC_DEVICE_TOKEN=%EXISTING_TOKEN%"
    echo [ИНФО] Обнаружен действующий токен в существующей конфигурации (сохранен без изменений).
)

:: Если токен все еще пуст, запросить интерактивно
if "%NOC_DEVICE_TOKEN%"=="" (
    echo.
    set /p "NOC_DEVICE_TOKEN=Введите токен авторизации кассы (NOC_TOKEN) [нажмите Enter, если настроите позже]: "
    if defined NOC_DEVICE_TOKEN (
        for /f "tokens=*" %%I in ("%NOC_DEVICE_TOKEN%") do set "NOC_DEVICE_TOKEN=%%~I"
    )
)

:: 5. Безопасное сохранение конфигурации и настройка модели прав доступа (ACL)
if not exist "%NOC_DIR%" mkdir "%NOC_DIR%" >nul 2>&1
if not exist "%NOC_DIR%" (
    echo [ОШИБКА] Не удалось создать каталог конфигурации "%NOC_DIR%"!
    goto cleanup_and_exit_fail
)

:: Настройка ACL каталога:
:: Administrators и SYSTEM: полный доступ (F)
:: Users (локальные пользователи кассы): чтение и выполнение (RX) для доступа 1С в файловом режиме
icacls "%NOC_DIR%" /inheritance:r /grant:r "Administrators":(OI)(CI)F /grant:r "SYSTEM":(OI)(CI)F /grant:r "Users":(OI)(CI)RX >nul 2>&1
if %errorlevel% neq 0 (
    echo [ОШИБКА] Не удалось настроить права доступа ACL (icacls) на каталог "%NOC_DIR%"!
    goto cleanup_and_exit_fail
)

:: Сохранение JSON с корректным экранированием через PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -Command "$cfg = $env:CONFIG_PATH; $url = $env:SERVER_URL; $tok = $env:NOC_DEVICE_TOKEN; $data = @{}; if (Test-Path $cfg) { try { $prev = Get-Content -Raw $cfg | ConvertFrom-Json; if ($prev.token -and -not $tok) { $data['token'] = $prev.token }; if ($prev.server_url -and -not $url) { $data['server_url'] = $prev.server_url } } catch {} }; if ($url) { $data['server_url'] = $url }; if ($tok) { $data['token'] = $tok }; $json = $data | ConvertTo-Json; [System.IO.File]::WriteAllText($cfg, $json, [System.Text.Encoding]::UTF8)" >nul 2>&1
if %errorlevel% neq 0 (
    :: Fallback запись при ошибке PowerShell
    if defined NOC_DEVICE_TOKEN (
        (
            echo {
            echo   "server_url": "%SERVER_URL%",
            echo   "token": "%NOC_DEVICE_TOKEN%"
            echo }
        ) > "%CONFIG_PATH%"
    ) else (
        (
            echo {
            echo   "server_url": "%SERVER_URL%"
            echo }
        ) > "%CONFIG_PATH%"
    )
)

if not exist "%CONFIG_PATH%" (
    echo [ОШИБКА] Не удалось создать файл конфигурации "%CONFIG_PATH%"!
    goto cleanup_and_exit_fail
)

:: Установка строгих ACL на config.json:
:: Administrators и SYSTEM: полный доступ (F)
:: Users: только чтение (R) — запрещена модификация и удаление неадминистраторами
icacls "%CONFIG_PATH%" /inheritance:r /grant:r "Administrators":F /grant:r "SYSTEM":F /grant:r "Users":R >nul 2>&1
if %errorlevel% neq 0 (
    echo [ОШИБКА] Не удалось применить права ACL к файлу "%CONFIG_PATH%"!
    goto cleanup_and_exit_fail
)

echo [ИНФО] Конфигурация сохранена с проверкой ACL (Administrators:F, SYSTEM:F, Users:R).
if defined NOC_DEVICE_TOKEN (
    echo [ИНФО] Токен устройства: сконфигурирован.
) else (
    echo [ИНФО] Токен устройства: не задан (задайте через NOC_TOKEN или в %CONFIG_PATH%).
)

:: Настройка каталога очереди Spool (%ProgramData%\1C-NOC\spool)
set "SPOOL_DIR=%NOC_DIR%\spool"
if not exist "%SPOOL_DIR%" mkdir "%SPOOL_DIR%" >nul 2>&1
if not exist "%SPOOL_DIR%" (
    echo [ОШИБКА] Не удалось создать каталог очереди "%SPOOL_DIR%"!
    goto cleanup_and_exit_fail
)

:: Настройка ACL очереди spool:
:: Языково-независимые Well-Known SID:
:: *S-1-5-32-544 (Administrators): (OI)(CI)F - полный доступ (папка и дочерние объекты)
:: *S-1-5-18     (SYSTEM):         (OI)(CI)F - полный доступ для фоновой службы (папка и дочерние объекты)
:: *S-1-3-0      (CREATOR OWNER):  (OI)(CI)(IO)F - создатель файла получает полный доступ к своему файлу (необходимо для MoveFileEx DELETE)
:: *S-1-5-32-545 (Users):          (RD,WD,RA,REA,X,S) - права ТОЛЬКО НА ПАПКУ (без (OI)/(CI)!): создание файлов (WD), листинг для Backpressure (RD).
::                                 Дочерние файлы НЕ наследуют WD для Users, что исключает чтение/модификацию чужих файлов.
icacls "%SPOOL_DIR%" /inheritance:r /grant:r "*S-1-5-32-544":(OI)(CI)F /grant:r "*S-1-5-18":(OI)(CI)F /grant:r "*S-1-3-0":(OI)(CI)(IO)F /grant:r "*S-1-5-32-545":(RD,WD,RA,REA,X,S) >nul 2>&1
if %errorlevel% neq 0 (
    echo [ОШИБКА] Не удалось настроить права доступа ACL (icacls) на каталог очереди "%SPOOL_DIR%"!
    goto cleanup_and_exit_fail
)

:: Настройка каталога карантина (%ProgramData%\1C-NOC\quarantine)
set "QUARANTINE_DIR=%NOC_DIR%\quarantine"
if not exist "%QUARANTINE_DIR%" mkdir "%QUARANTINE_DIR%" >nul 2>&1
if not exist "%QUARANTINE_DIR%" (
    echo [ОШИБКА] Не удалось создать каталог карантина "%QUARANTINE_DIR%"!
    goto cleanup_and_exit_fail
)

:: Карантин доступен ТОЛЬКО службе SYSTEM и Администраторам
icacls "%QUARANTINE_DIR%" /inheritance:r /grant:r "*S-1-5-32-544":(OI)(CI)F /grant:r "*S-1-5-18":(OI)(CI)F >nul 2>&1
if %errorlevel% neq 0 (
    echo [ОШИБКА] Не удалось настроить права доступа ACL (icacls) на каталог карантина "%QUARANTINE_DIR%"!
    goto cleanup_and_exit_fail
)

echo [ИНФО] Каталоги очереди (spool) и карантина (quarantine) инициализированы.
echo       Права настроены по SID (*S-1-3-0 CREATOR OWNER:F, *S-1-5-32-545 Users:RD,WD,RA,REA,X,S [папка]).

:: Фиксация архитектурного блокера
echo [АРХИТЕКТУРНЫЙ БЛОКЕР] В файловой 1С серверный BSL-код исполняется в контексте кассира (Users).
echo                      Полная изоляция секрета будет обеспечена на Фазе 4.2 через фоновую службу Windows.

:: 6. Обнаружение клиентов удаленного доступа (AnyDesk / RuDesktop)
:: ПРИНЦИП БЕЗОПАСНОСТИ: Пароли не задаются и не сохраняются в скриптах!
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

:: 7. Загрузка расширения support.cfe с валидацией TLS и проверкой кода возврата
set "CFE_URL=%SERVER_URL%/downloads/support.cfe"
set "TEMP_CFE=%TEMP%\support_%RANDOM%_%TIME:~6,2%.cfe"
if exist "%TEMP_CFE%" del /f /q "%TEMP_CFE%" >nul 2>&1

echo [2/3] Загрузка артефакта расширения: %CFE_URL%...

set "DL_EXIT_CODE=0"
where curl >nul 2>&1
if %errorlevel% equ 0 (
    curl -f -s -S -o "%TEMP_CFE%" "%CFE_URL%"
    set "DL_EXIT_CODE=%errorlevel%"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13; (New-Object Net.WebClient).DownloadFile('%CFE_URL%', '%TEMP_CFE%')" >nul 2>&1
    set "DL_EXIT_CODE=%errorlevel%"
)

if %DL_EXIT_CODE% neq 0 (
    echo [ОШИБКА] Сбой загрузки support.cfe по адресу: %CFE_URL% (код: %DL_EXIT_CODE%).
    if exist "%TEMP_CFE%" del /f /q "%TEMP_CFE%" >nul 2>&1
    goto cleanup_and_exit_fail
)

if not exist "%TEMP_CFE%" (
    echo [ОШИБКА] Загруженный файл support.cfe не найден во временном каталоге.
    goto cleanup_and_exit_fail
)

:: Проверка ненулевого размера файла
for %%A in ("%TEMP_CFE%") do if %%~zA equ 0 (
    echo [ОШИБКА] Загруженный файл support.cfe имеет нулевой размер!
    del /f /q "%TEMP_CFE%" >nul 2>&1
    goto cleanup_and_exit_fail
)

:: Проверка целостности контейнера 1С (сигнатура Compound Container 0x7FFFFFFF: FF FF FF 7F)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$bytes = [System.IO.File]::ReadAllBytes($env:TEMP_CFE); if ($bytes.Length -lt 512 -or $bytes[0] -ne 255 -or $bytes[1] -ne 255 -or $bytes[2] -ne 255 -or $bytes[3] -ne 127) { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo [ОШИБКА] Целостность support.cfe нарушена: файл не является валидным контейнером 1С!
    del /f /q "%TEMP_CFE%" >nul 2>&1
    goto cleanup_and_exit_fail
)

:: Вычисление хеша SHA-256 артефакта
set "CFE_SHA256="
certutil -hashfile "%TEMP_CFE%" SHA256 > "%TEMP%\cfe_hash.tmp" 2>&1
for /f "skip=1 tokens=*" %%H in ('type "%TEMP%\cfe_hash.tmp"') do (
    if not defined CFE_SHA256 set "CFE_SHA256=%%H"
)
if exist "%TEMP%\cfe_hash.tmp" del /f /q "%TEMP%\cfe_hash.tmp" >nul 2>&1

echo [OK] Файл support.cfe успешно проверен (SHA-256: %CFE_SHA256%).
echo [ИНФО] Требуемая схема защиты: В production необходима проверка цифровой
echo       подписи манифеста OTA корневым сертификатом NOC до вызова Конфигуратора.

:: 8. Поиск исполняемого файла 1С:Предприятие
set "ONEC_EXE="
if exist "%ProgramFiles%\1cv8\common\1cestart.exe" set "ONEC_EXE=%ProgramFiles%\1cv8\common\1cestart.exe"
if exist "%ProgramFiles(x86)%\1cv8\common\1cestart.exe" set "ONEC_EXE=%ProgramFiles(x86)%\1cv8\common\1cestart.exe"

if "%ONEC_EXE%"=="" (
    echo [ОШИБКА] Не найден 1cestart.exe в стандартных каталогах!
    echo          Убедитесь, что платформа 1С:Предприятие 8.3 установлена на этом компьютере.
    goto cleanup_and_exit_fail
)

echo [ИНФО] Обнаружен стартер 1С: "%ONEC_EXE%"

:: 9. Проверка блокировок активных процессов 1С (Process Guard)
tasklist /fi "imagename eq 1cv8.exe" 2>nul | find /i "1cv8.exe" >nul
if %errorlevel% equ 0 (
    echo.
    echo [ВНИМАНИЕ] Обнаружен активный процесс 1cv8.exe!
    echo           Для бесконфликтного применения расширения закройте 1С на 30 секунд.
    echo           Нажмите любую клавишу после закрытия 1С...
    pause >nul
)

:: 10. Пакетная посадка расширения в информационную базу
echo [3/3] Внедрение расширения "_МониторСаппорта" в базу 1С...
echo       (Выполняется обновление конфигурации, пожалуйста, подождите)...

start /wait "" "%ONEC_EXE%" DESIGNER /F "%BASE_PATH%" /LoadCfg "%TEMP_CFE%" -Extension "_МониторСаппорта" /UpdateDBCfg
set "ONEC_EXIT_CODE=%errorlevel%"

:: Гарантированная очистка временного файла
if exist "%TEMP_CFE%" del /f /q "%TEMP_CFE%" >nul 2>&1

if %ONEC_EXIT_CODE% neq 0 (
    echo [ОШИБКА] Конфигуратор 1С завершился с кодом ошибки %ONEC_EXIT_CODE%!
    echo          Возможные причины:
    echo          - База 1С открыта кассиром монопольно;
    echo          - Недостаточно прав на запись в каталог базы;
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
echo  - Конфигурация защищена NTFS ACL (Administrators:F, SYSTEM:F, Users:R).
echo  - Опрос телеметрии начнется автоматически.
echo ====================================================
echo.

:: 11. Безопасная очистка переменных секретов из памяти процесса перед выходом
set "ARG_DEVICE_TOKEN="
set "NOC_DEVICE_TOKEN="
set "NOC_TOKEN="
set "EXISTING_TOKEN="
set "CFE_SHA256="
pause
exit /b 0

:cleanup_and_exit_fail
if exist "%TEMP_CFE%" del /f /q "%TEMP_CFE%" >nul 2>&1
if exist "%TEMP%\cfe_hash.tmp" del /f /q "%TEMP%\cfe_hash.tmp" >nul 2>&1
set "ARG_DEVICE_TOKEN="
set "NOC_DEVICE_TOKEN="
set "NOC_TOKEN="
set "EXISTING_TOKEN="
set "CFE_SHA256="
echo.
pause
exit /b 1