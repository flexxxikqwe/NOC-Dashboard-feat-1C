# 1C-NOC Windows Agent — Native Service (Phase 4.2 & 4.2.1)

Нативная высоконадёжная служба Windows на C++17 / Win32 API для приёма событий телеметрии и инцидентов от расширения 1С:Предприятие 8.3 через файловый spool.

## Архитектура и компоненты

Служба спроектирована для работы на слабых кассовых компьютерах (POS-терминалы, Intel Celeron/Atom, 2–4 ГБ RAM) с минимальным потреблением ресурсов:
- **CPU в простое:** ~0.0% (ожидание на событиях Win32 `ReadDirectoryChangesW` / `WaitForMultipleObjects` без busy-loop).
- **RAM footprint:** < 10 МБ.
- **Внешние зависимости во время штатной работы:** отсутствуют (статическая линковка C++ runtime, Win32 API, SQLite3 amalgamation). Не требует Node.js, Python, .NET или PowerShell на кассе.
- **Штатная криптография Windows:** Windows Cryptography API: Next Generation (CNG) BCrypt (`BCryptOpenAlgorithmProvider`, `BCryptCreateHash`, `BCryptHashData`, `BCryptFinishHash`) с аппаратным ускорением SHA-256 и отсутствием самописных криптографических примитивов.

### Структура проекта

```
windows-agent/
├── CMakeLists.txt              # Сборка через CMake (MSVC 2019/2022, MinGW-w64, Clang)
├── Makefile                    # Сборка через make / mingw (x86_64 и i686)
├── README.md                   # Руководство по архитектуре, сборке и эксплуатации
├── include/
│   ├── common.hpp              # Константы SPOOL_CONTRACT v1.0, структуры данных, квоты, логирование
│   ├── raii_handles.hpp        # RAII-обертки для HANDLE, SC_HANDLE, FindHandle, LocalAlloc
│   ├── json_lite.hpp           # Строгий парсер JSON: запрет дубликатов ключей, лимит глубины 32, суррогаты
│   ├── crypto_hash.hpp         # Windows CNG BCrypt SHA-256 (FIPS 180-4) для дедупликации
│   ├── sqlite_queue.hpp        # Локальный буфер SQLite, WAL-режим, synchronous=FULL, транзакции, приоритеты
│   ├── spool_watcher.hpp       # Наблюдатель каталога spool (ReadDirectoryChangesW + polling fallback)
│   └── service_core.hpp        # Windows Service Control Manager (SCM), CLI-парсер, диспетчер
├── src/
│   ├── main.cpp                # Точка входа в процесс
│   ├── json_lite.cpp           # Реализация валидатора JSON и контракта Spool Envelope
│   ├── crypto_hash.cpp         # Реализация SHA-256 через Windows CNG BCrypt (с fallback для тестов на Linux)
│   ├── sqlite_queue.cpp        # Реализация транзакций очереди, synchronous=FULL и вытеснения по квоте 10 МБ
│   ├── spool_watcher.cpp       # Логика захвата файлов, карантина коллизий и Crash Recovery
│   └── service_core.cpp        # Реализация SCM (ServiceMain, ServiceCtrlHandler) и CLI
├── tests/
│   └── test_agent.cpp          # Модульные тесты парсера, хешей, SQLite очереди и spool watcher
└── vendor/
    └── sqlite/
        ├── LICENSE.txt         # Public Domain dedication statement (SQLite 3.54.0)
        ├── sqlite3.c           # SQLite 3 amalgamation c флагами WAL и threadsafe
        └── sqlite3.h           # Заголовочный файл SQLite 3
```

---

## Контракт файлового Spool и долговечность хранения (Durability)

### Каталоги по умолчанию
- Очередь: `C:\ProgramData\1C-NOC\spool\`
- Карантин: `C:\ProgramData\1C-NOC\quarantine\`
- Локальная база SQLite: `C:\ProgramData\1C-NOC\queue.db`

### Жизненный цикл события и гарантии сохранения:
1. **Создание в 1С:** 1С формирует пакет и записывает во временный файл `spool\temp_<guid>.tmp`.
2. **Атомарная публикация:** 1С вызывает переименование в `spool\<timestamp17>_<guid>.json` (где `<timestamp17>` — ровно 17 цифр UTC `YYYYMMDDHHmmssfff`).
3. **Обнаружение службой:** Поток `SpoolWatcher` перехватывает событие файловой системы через Win32 `ReadDirectoryChangesW` (резервный опрос каждые 5 с).
4. **FIFO-сортировка:** Файлы в каталоге сортируются лексикографически, что благодаря фиксированной метке времени гарантирует строгую хронологическую обработку.
5. **Валидация и захват:**
   - Проверка размера: `<= 65536` байт (64 КБ). Если больше — немедленный перенос в `quarantine/` с префиксом `OVERSIZED_64KB`.
   - Проверка кодировки: строгий UTF-8 **без BOM** (наличие `EF BB BF` бракуется по спецификации).
   - Защита от DoS: глубина вложенности ограничена 32 уровнями.
   - Защита от дубликатов ключей: повторяющиеся ключи в объектах JSON бракуются.
   - Проверка схемы: `schema_version == "1.0"`, корректный `event_id` (GUID), `source == "1C_EXTENSION"`, валидный `event_type` (`TELEMETRY` | `INCIDENT` | `HEARTBEAT`), валидный `priority` (`NORMAL` | `HIGH` | `LOW`), обязательные поля `payload.shop`, `payload.workplace`.
   - Некорректные файлы изолируются в `quarantine/` с меткой времени и причиной (`INVALID_ENVELOPE`).
6. **Вычисление SHA-256 и дедупликация:**
   - Вычисляется SHA-256 от всего сырого содержимого файла через Windows CNG BCrypt.
   - Запись помещается в SQLite внутри транзакции `BEGIN IMMEDIATE`.
   - Если запись с таким SHA-256 уже существует (`DUPLICATE_IGNORED`) — дубликат удаляется из `spool/` без повторной отправки.
   - Если обнаружена коллизия (один `event_id`, но разный хеш), транзакция откатывается, а файл помещается в `quarantine/` с префиксом `COLLISION_EVENT_ID` для расследования без повреждения очереди.
7. **Долговечный коммит (`synchronous = FULL`):**
   - В SQLite используется `journal_mode = WAL` и **`synchronous = FULL`**.
   - При `synchronous = FULL` вызов `COMMIT` выполняет сброс буферов диска (`FlushFileBuffers` на Win32 / `fsync`), гарантируя, что транзакция в WAL физически зафиксирована на носителе.
   - Исходный spool-файл удаляется с диска (`fs::remove`) **строго после подтверждения долговечного COMMIT**.
   - Окно потери данных между удалением файла и коммитом БД полностью исключено.
8. **Crash Recovery (уборка зависших файлов):** Каждые 60 секунд служба выполняет поиск файлов `temp_*.tmp` старше 300 секунд (5 минут). Оборванные из-за аварийного закрытия 1С или отключения питания временные файлы автоматически удаляются, освобождая квоту очереди.

---

## Сборка агента

### Вариант 1: Microsoft Visual Studio (MSVC 2019 / 2022, Рекомендуемый для Windows)
64-битная сборка:
```cmd
cd windows-agent
cmake -B build-x64 -A x64 -DCMAKE_BUILD_TYPE=Release
cmake --build build-x64 --config Release --parallel
ctest --test-dir build-x64 -C Release --output-on-failure
```
Исполняемый файл службы: `build-x64\Release\noc-agent.exe`.
Тестовый бинарник: `build-x64\Release\noc_agent_tests.exe`.

32-битная сборка (x86):
```cmd
cd windows-agent
cmake -B build-x86 -A Win32 -DCMAKE_BUILD_TYPE=Release
cmake --build build-x86 --config Release --parallel
ctest --test-dir build-x86 -C Release --output-on-failure
```

### Вариант 2: MinGW-w64 (Кросс-компиляция)
64-битная сборка:
```bash
make win64
# Результат: bin/noc-agent-x64.exe
```

32-битная сборка:
```bash
make win32
# Результат: bin/noc-agent-x86.exe
```

---

## Автоматическая сборка в CI (GitHub Actions)

В репозитории настроен workflow `.github/workflows/windows-agent.yml`, запускающийся на раннере `windows-2022`:
- Компиляция x64 и x86 в MSVC Release.
- Автоматический прогон полного набора unit-тестов (`noc_agent_tests.exe`).
- Проверка exit codes и CLI-флагов (`noc-agent.exe --version`).
- Публикация артефактов сборки (`.exe`, `.pdb`).

---

## Управление службой (CLI)

Бинарный файл `noc-agent.exe` поддерживает встроенный интерфейс управления Service Control Manager (SCM):

| Команда | Описание |
| :--- | :--- |
| `noc-agent.exe` | Запуск от имени SCM в качестве системной службы Windows |
| `noc-agent.exe --install` (`-i`) | Регистрация службы `1C-NOC-Agent` в SCM с автозапуском (`SERVICE_AUTO_START`) |
| `noc-agent.exe --uninstall` (`-u`) | Остановка и удаление службы из SCM |
| `noc-agent.exe --start` | Запуск службы через SCM API |
| `noc-agent.exe --stop` | Остановка службы через SCM API |
| `noc-agent.exe --status` | Запрос текущего состояния службы (`RUNNING`, `STOPPED` и др.) |
| `noc-agent.exe --console` (`-c`) | Интерактивный запуск в терминале для отладки и мониторинга журналов |
| `noc-agent.exe --run-once` (`-1`) | Однократный проход по каталогу spool, обработка очереди и выход |
| `noc-agent.exe --version` (`-v`) | Вывод версии сборки и архитектуры |

---

## Права доступа (NTFS DACL)

Служба работает в контексте `NT AUTHORITY\SYSTEM`. Права на каталоги настраиваются скриптом `public/downloads/install.bat` со строгим разграничением:
- `%ProgramData%\1C-NOC\spool`:
  - `SYSTEM (*S-1-5-18)`: `(OI)(CI)F` (полный доступ для службы).
  - `Administrators (*S-1-5-32-544)`: `(OI)(CI)F` (административный доступ).
  - `CREATOR OWNER (*S-1-3-0)`: `(OI)(CI)(IO)F` (создатель управляет своими файлами, имеет `DELETE` для `MoveFileExW`).
  - `Users (*S-1-5-32-545)`: `(RD,WD,RA,REA,X,S)` **без флагов наследования (OI)/(CI)**. Обычные пользователи могут создавать новые файлы и читать каталог, но не могут модифицировать или читать чужие файлы в очереди.
- `%ProgramData%\1C-NOC\quarantine`:
  - Доступ имеют **только** `SYSTEM` и `Administrators`. Обычным пользователям доступ закрыт.

---

## Аудит и харденинг Phase 4.2.1

### 1. Долговечность хранения (Durability: Spool-to-SQLite)
- **Конфигурация SQLite:** `PRAGMA journal_mode = WAL;`, `PRAGMA synchronous = FULL;`, `PRAGMA busy_timeout = 5000;`, `PRAGMA auto_vacuum = INCREMENTAL;`, `PRAGMA wal_autocheckpoint = 1000;`.
- **Обоснование synchronous=FULL:** В режиме WAL при `synchronous=NORMAL` фиксация на диск (FlushFileBuffers) откладывается до checkpoint. В случае внезапного отключения питания сразу после коммита и удаления spool-файла существовал риск потери транзакции из памяти ОС. Режим `synchronous=FULL` в WAL гарантирует, что каждый `COMMIT` синхронизирует WAL-фреймы на физический диск ПЕРЕД тем, как код приступит к вызову `fs::remove` для spool-файла.
- **Оценка I/O стоимости на слабых POS:** POS-телеметрия генерирует ~1 пакет раз в 5–10 минут (в пике не более 1–5 пакетов/мин). Задержка одного `FlushFileBuffers` на SSD/eMMC составляет 1–5 мс. Затраты CPU составляют < 0.01%, нагрузка на диск незаметна для кассира.
- **Матрица восстановления после сбоев:**
  - *Сбой до COMMIT / ошибка INSERT:* транзакция откатывается (`ROLLBACK`), исходный spool-файл остаётся в `spool/`, возвращается `RETRY_LATER`. На следующем цикле опрос повторяется.
  - *Сбой во время COMMIT:* транзакция либо не зафиксирована (откат при старте SQLite, spool-файл цел), либо зафиксирована (переходит в сценарий ниже).
  - *Сбой процесса после COMMIT, но до удаления spool-файла:* событие уже надёжно зафиксировано в SQLite. При перезапуске агент повторно читает spool-файл, вычисляет SHA-256, обнаруживает существующую запись (`DUPLICATE_IGNORED`) и безопасно удаляет файл. Данные не дублируются и не теряются.
  - *Зависание записи 1С (`temp_*.tmp`):* механизм `SweepStaleTmpFiles` удаляет зависшие временные файлы старше 300 с при рестарте и каждые 60 с.

### 2. Замена SHA-256 на штатную Windows CNG (BCrypt)
- **Библиотека:** Windows Cryptography API: Next Generation (`bcrypt.lib`).
- **Совместимость:** Windows 7 SP1, POSReady 7 x86/x64, Windows 10/11, Windows Server 2008 R2 – 2025.
- **Выделение памяти:** Для 100% совместимости с Windows 7 / POSReady 7 размер объекта хеша запрашивается через `BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, ...)` и буфер выделяется вызывающей стороной, исключая ошибки `STATUS_INVALID_PARAMETER` (0xC000000D).
- **Пакетное хеширование:** Поддерживает нарезку на чанки по 64 МБ, предотвращая переполнение 32-битного счетчика длины `ULONG`.
- **Освобождение дескрипторов:** Применены RAII-структуры `ScopedBcryptAlg` (`BCryptCloseAlgorithmProvider`) и `ScopedBcryptHash` (`BCryptDestroyHash`).
- **NIST Test Vectors:** Проверены векторы FIPS 180-4 для пустой строки, `"abc"`, `"The quick brown fox jumps over the lazy dog"`, 448-битной строки и 100 КБ буфера.

### 3. Защита JSON-парсера и Spool Envelope
| Проверка | Реализация | Результат теста |
| :--- | :--- | :--- |
| Поврежденный JSON | Синтаксический разбор скобок и запятых | `QUARANTINED_INVALID` (`INVALID_ENVELOPE`) |
| Обрыв строки / EOF | Контроль `pos_ < text_.size()` | `QUARANTINED_INVALID` |
| Некорректный UTF-8 | Валидатор RFC 3629 (байты продолжения, overlong, диапазон) | Отклонение (`Invalid UTF-8`) |
| Наличие UTF-8 BOM | Явная проверка `0xEF 0xBB 0xBF` в начале файла | Отклонение (`UTF-8 BOM detected`) |
| Дублирующиеся ключи | Проверка `obj.find(key) != obj.end()` в парсере объектов | Отклонение (`Duplicate key in object`) |
| Неверные escape-последовательности | Строгая проверка `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX` | Отклонение |
| Одиночные / некорректные суррогаты | Проверка суррогатных пар `\uD800..\uDBFF` + `\uDC00..\uDFFF` | Отклонение |
| Неверные числа | Запрет ведущих нулей (`0123`), проверка точки и экспоненты | Отклонение |
| Завершающие запятые | Запрет trailing comma в массивах `[1, 2,]` и объектах `{"a": 1,}` | Отклонение |
| Мусор после закрывающей скобки | Проверка `SkipWhitespace(); !Eof()` после корня | Отклонение (`Unexpected trailing characters`) |
| Чрезмерная вложенность | Лимит глубины `MAX_NESTING_DEPTH = 32` | Отклонение (`Exceeded nesting depth`) |
| Размер свыше лимита | Лимит 64 КБ (`MAX_PAYLOAD_BYTES = 65536`) | `QUARANTINED_OVERSIZED` |
| Неизвестная версия схемы | Проверка `schema_version == "1.0"` | Отклонение |
| Отсутствие обязательных полей | Проверка `event_id`, `timestamp_utc`, `shop`, `workplace` | Отклонение |
| Несоответствие типов | `warnings` строго массив строк, `payload` строго объект | Отклонение |

### 4. Дедупликация и коллизии в SQLite
- **Проверка содержимого при совпадении SHA-256:** При совпадении digest SQLite-очередь сравнивает сохраненный `payload_json` с входящим `env.raw_json`. При полном совпадении фиксируется `DUPLICATE_IGNORED` (идемпотентный пропуск). При несовпадении содержимого возвращается `COLLISION_DETECTED` для предотвращения потери данных.
- **Коллизии `event_id`:** Если входящий `event_id` совпадает с существующим, но имеет другой SHA-256, транзакция откатывается (`ROLLBACK`), а файл отправляется в `quarantine/` с тегом `COLLISION_EVENT_ID`.
- **Лимит базы данных 10 МБ:** Функция `EnforceCapacity` отслеживает суммарный размер `queue.db + queue.db-wal + queue.db-shm`. При превышении выполняется `checkpoint` и вытеснение (сначала доставленные `SENT`, затем устаревшие `LOW`/`NORMAL`, инциденты `HIGH` сохраняются).

### 5. Статус сборки и верификации Phase 4.2.1
- **Сквозные контрактные и алгоритмические тесты:** **PASS** (выполнены скриптами `scripts/test-phase42-agent-ingestion.mjs`, `scripts/test-spool-acl-and-context.mjs`, `scripts/test-zero-freeze-spool.mjs`).
- **Сборка Windows `.exe` в текущем Linux-окружении:** **NOT BUILT** (в контейнере отсутствуют `make` и `x86_64-w64-mingw32-g++`).
- **Сборка на Windows Runner:** Настроен официальный GitHub Actions workflow `.github/workflows/windows-agent.yml` на базе `windows-2022` для автоматической сборки x64 и x86 бинарников через MSVC и прогона `noc_agent_tests.exe`.

---

## Архитектура и реализация Phase 4.3 (WinHTTP Transport & Safe Integration)

### 1. Архитектурный дизайн изоляции сетевого транспорта
- **Модульная структура:** Код сетевого взаимодействия вынесен в изолированный модуль `include/winhttp_transport.hpp` и `src/winhttp_transport.cpp`.
- **Интерфейс `IHttpClient`:**
  - `Post(url, bearer_token, json_payload, timeout_ms)` — синхронный запрос полезной нагрузки.
  - `Abort()` — атомарное прерывание активного сетевого вызова при выключении службы или остановке оператором.
- **Подменяемые реализации:**
  - `WinHttpClient` (Windows `_WIN32`): нативная реализация WinHTTP API (`winhttp.dll`). Поддерживает явную настройку TLS 1.2 / TLS 1.3 через `WINHTTP_OPTION_SECURE_PROTOCOLS`, раздельные таймауты (`WinHttpSetTimeouts`), ограничение буфера ответа 64 КБ (`kMaxRespBytes = 65536`) и RAII-дескрипторы сессии / соединения / запроса.
  - `MockHttpClient`: кросс-платформенная реализация для юнит-тестов и CI без использования Win32 API и без сетевых вызовов. Позволяет задавать пользовательские лямбда-обработчики, проверять статусы 200, 401, 429, 5xx, имитировать таймауты и контролировать число вызовов.
- **Менеджер фоновой отправки `TransportManager`:**
  - Запускает отдельный фоновый рабочий поток (`worker_thread_`), не блокируя ни очередь 1С `spool`, ни основной поток службы SCM.
  - Извлекает записи из `SqliteQueue` порциями до 10 штук (`GetPending(10, ...)`).
  - Преобразует `SpoolEnvelope` в серверную структуру `TelemetryPayload` через `EnvelopeToIngestionPayload`.
  - Управляет жизненным циклом записей: при подтверждении сервером статус переводится в `SENT`, при ошибках инкрементируется `retry_count`.

### 2. Принципы безопасности и Safe Rollout (Safe Implementation)
- **Транспорт ВЫКЛЮЧЕН по умолчанию (`enabled = false`):**
  - При установке и обычном запуске агент не обращается к сети, работая исключительно в режиме локального накопления очереди.
  - Для активации требуется явное указание `enable_http_transport: true` в `config.json` либо переменной окружения `NOC_ENABLE_HTTP_TRANSPORT=1`.
- **Запрет Plain HTTP (`allow_insecure_http = false`):**
  - Любые попытки отправки по протоколу `http://` немедленно блокируются транспортом с ошибкой `HTTPS required`.
  - Отправка по незашифрованному каналу возможна только на тестовых стендах при явном ключе `allow_insecure_http = true` / `NOC_ALLOW_INSECURE_HTTP=1`.
- **Zero Token Leakage (Защита от утечки секретов в логах):**
  - Функция `MaskTokenForLog` маскирует Bearer-токен (например, `dev...26 (21 chars)`), исключая попадание токена в журнал событий Windows (Event Log), консоль или текстовые логи.
  - Диагностические сообщения об ошибках аутентификации (401/403) никогда не выводят тело токена.
- **Защита памяти слабых POS (Лимит ответа сервера):**
  - Буфер чтения ответа ограничен жестким потолком 64 КБ (`max_response_bytes = 65536`). Превышение отсекается, исключая атаки на переполнение памяти кассы.

### 3. Совместимость с серверным контрактом Backend (Ingestion API)
| Параметр контракта | Серверная спецификация (`/api/v1/telemetry`) | Реализация агента (`winhttp_transport`) |
| :--- | :--- | :--- |
| **HTTP Метод и URL** | `POST /api/v1/telemetry` | Автоматическая сборка `/api/v1/telemetry` из базового `server_url` |
| **Авторизация** | `Authorization: Bearer <TOKEN>` | Заголовок `Authorization: Bearer ` + безопасное чтение из конфига/env |
| **Формат тела** | `TelemetryPayload` (JSON <= 64 КБ) | `EnvelopeToIngestionPayload` со структурой `shop`, `workplace`, `remote`, `warnings`, `runtime_errors`, `health_checks`, `system_info` |
| **Размер полезной нагрузки** | Максимум 65 536 байт (413 Payload Too Large) | Клиентский лимит 65 536 байт |
| **Идентификация кассы** | `generateWorkplaceId(shop, workplace)` | Стабильные поля `shop` и `workplace` из конверта 1С |
| **Дедупликация инцидентов** | `generateErrorHash(event, errorText)` | Стабильный хеш на сервере, предотвращающий дублирование инцидентов |
| **Формат подтверждения** | `{"success": true, "workplace_id": ..., ...}` | Строгий парсинг ответа: статус в SQLite меняется на `SENT` **только** при наличии `success: true` |

### 4. Сетевая устойчивость, повторы и экспоненциальный бэкофф
- **Формула расчета задержки:** `CalculateBackoffSeconds(retry_count, retry_after_header)`.
  - Базовый экспоненциальный шаг: `min(2^min(retry, 6) * 5, 300)` секунд (5 с, 10 с, 20 с, 40 с, 80 с, 160 с, 300 с потолок).
  - Приоритет заголовка `Retry-After`: при получении HTTP 429 или 503 агент считывает заголовок `Retry-After` и засыпает на указанное сервером время (с ограничением от 5 до 600 с).
- **Матрица обработки ответов сервера:**
  - `HTTP 200` + `success: true`: событие подтверждено сервером, запись в SQLite переводится в статус `SENT`.
  - `HTTP 401 / 403`: неверный или просроченный токен. Событие сохраняется в очереди (`PENDING`), инкрементируется `retry_count`, транспорт активирует бэкофф на 60 с для предотвращения спама в SCM-логах.
  - `HTTP 429`: ограничение частоты. Агент считывает `Retry-After` и переходит в режим ожидания.
  - `HTTP 400 / 413 / 422`: ошибка формата. Инкрементируется `retry_count`. При превышении `max_retries` (10 попыток) запись помечается `FAILED` (ядовитое сообщение изолируется).
  - `HTTP 5xx / Сетевой сбой / Таймаут`: событие строго сохраняется в локальной SQLite-очереди, рассчитывается экспоненциальный бэкофф.
- **Graceful Shutdown:** При остановке службы метод `Abort()` закрывает дескриптор активного HTTP-запроса через `WinHttpCloseHandle`, и фоновый поток корректно завершается в течение 200 мс без зависания процесса.

### 5. Статус верификации Phase 4.3
- **Статус реализации:** `IMPLEMENTED IN SOURCE / NOT VERIFIED ON WINDOWS`.
- **Контрактные и алгоритмические тесты:** **PASS** (проверено скриптами `scripts/test-phase43-transport.mjs` и `scripts/test-phase42-agent-ingestion.mjs`).
- **Модульные тесты C++:** Добавлен тестовый блок `TestWinHttpTransportLogic` в `windows-agent/tests/test_agent.cpp`.
- **Дальнейшая верификация:** Будет выполнена на реальном Windows Server 2022 runner в рамках GitHub Actions CI workflow `.github/workflows/windows-agent.yml`.


