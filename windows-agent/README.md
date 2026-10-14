# 1C-NOC Windows Agent — Native Service (Phase 4.2)

Нативная высоконадёжная служба Windows на C++17 / Win32 API для приёма событий телеметрии и инцидентов от расширения 1С:Предприятие 8.3 через файловый spool.

## Архитектура и компоненты

Служба спроектирована для работы на слабых кассовых компьютерах (POS-терминалы, Intel Celeron/Atom, 2–4 ГБ RAM) с минимальным потреблением ресурсов:
- **CPU в простое:** ~0.0% (ожидание на событиях Win32 `ReadDirectoryChangesW` / `WaitForMultipleObjects` без busy-loop).
- **RAM footprint:** < 10 МБ.
- **Внешние зависимости во время штатной работы:** отсутствуют (статическая линковка C++ runtime, Win32 API, SQLite3 amalgamation). Не требует Node.js, Python, .NET или PowerShell на кассе.

### Структура проекта

```
windows-agent/
├── CMakeLists.txt              # Сборка через CMake (MSVC 2019/2022, MinGW-w64, Clang)
├── Makefile                    # Сборка через make / mingw (x86_64 и i686)
├── include/
│   ├── common.hpp              # Константы SPOOL_CONTRACT v1.0, структуры данных, квоты, логирование
│   ├── raii_handles.hpp        # RAII-обертки для HANDLE, SC_HANDLE, FindHandle, LocalAlloc
│   ├── json_lite.hpp           # Строгий парсер JSON без исключений, валидатор UTF-8 без BOM
│   ├── crypto_hash.hpp         # Реализация SHA-256 (FIPS 180-4) для дедупликации
│   ├── sqlite_queue.hpp        # Локальный буфер SQLite, WAL-режим, транзакции, приоритеты
│   ├── spool_watcher.hpp       # Наблюдатель каталога spool (ReadDirectoryChangesW + polling fallback)
│   └── service_core.hpp        # Windows Service Control Manager (SCM), CLI-парсер, диспетчер
├── src/
│   ├── main.cpp                # Точка входа в процесс
│   ├── json_lite.cpp           # Реализация валидатора JSON и контракта Spool Envelope
│   ├── crypto_hash.cpp         # Реализация SHA-256
│   ├── sqlite_queue.cpp        # Реализация транзакций очереди и вытеснения по квоте 10 МБ
│   ├── spool_watcher.cpp       # Логика захвата файлов, карантина и Crash Recovery
│   └── service_core.cpp        # Реализация SCM (ServiceMain, ServiceCtrlHandler) и CLI
├── tests/
│   └── test_agent.cpp          # Модульные тесты парсера, хешей, SQLite очереди и spool watcher
└── vendor/
    └── sqlite/
        ├── sqlite3.c           # SQLite 3 amalgamation c флагами WAL и threadsafe
        └── sqlite3.h           # Заголовочный файл SQLite 3
```

---

## Контракт файлового Spool и обработка событий

### Каталоги по умолчанию
- Очередь: `C:\ProgramData\1C-NOC\spool\`
- Карантин: `C:\ProgramData\1C-NOC\quarantine\`
- Локальная база SQLite: `C:\ProgramData\1C-NOC\queue.db`

### Жизненный цикл события:
1. **Создание в 1С:** 1С формирует пакет и записывает во временный файл `spool\temp_<guid>.tmp`.
2. **Атомарная публикация:** 1С вызывает переименование в `spool\<timestamp17>_<guid>.json` (где `<timestamp17>` — ровно 17 цифр UTC `YYYYMMDDHHmmssfff`).
3. **Обнаружение службой:** Поток `SpoolWatcher` перехватывает событие файловой системы через Win32 `ReadDirectoryChangesW` (резервный опрос каждые 5 с).
4. **FIFO-сортировка:** Файлы в каталоге сортируются лексикографически, что благодаря фиксированной метке времени гарантирует строгую хронологическую обработку.
5. **Валидация и захват:**
   - Проверка размера: `<= 65536` байт (64 КБ). Если больше — немедленный перенос в `quarantine/` с префиксом `OVERSIZED_64KB`.
   - Проверка кодировки: строгий UTF-8 **без BOM** (наличие `EF BB BF` бракуется по спецификации).
   - Проверка схемы: `schema_version == "1.0"`, корректный `event_id` (GUID), `source == "1C_EXTENSION"`, валидный `event_type` (`TELEMETRY` | `INCIDENT` | `HEARTBEAT`), валидный `priority` (`NORMAL` | `HIGH` | `LOW`), обязательные поля `payload.shop`, `payload.workplace`.
   - Некорректные файлы изолируются в `quarantine/` с меткой времени и причиной (`INVALID_ENVELOPE`).
6. **Вычисление SHA-256 и дедупликация:**
   - Вычисляется SHA-256 от всего сырого содержимого файла.
   - Запись помещается в SQLite внутри транзакции `BEGIN IMMEDIATE`.
   - Если запись с таким SHA-256 уже существует (`DUPLICATE_IGNORED`) — дубликат удаляется из `spool/` без повторной отправки.
   - Если обнаружена коллизия (один `event_id`, но разный хеш), выводится предупреждение в журнал.
7. **Удаление из spool:** Только после успешной фиксации в SQLite (`COMMIT`) исходный JSON-файл удаляется с диска (`MoveFileExW` / `DeleteFileW`).
8. **Crash Recovery (уборка зависших файлов):** Каждые 60 секунд служба выполняет поиск файлов `temp_*.tmp` старше 300 секунд (5 минут). Оборванные из-за аварийного закрытия 1С или отключения питания временные файлы автоматически удаляются, освобождая квоту очереди.

---

## Сборка агента

### Вариант 1: Microsoft Visual Studio (MSVC 2019 / 2022)
```cmd
cd windows-agent
mkdir build
cd build
cmake -G "Visual Studio 17 2022" -A x64 ..
cmake --build . --config Release
```
Исполняемый файл службы: `build\Release\noc-agent.exe`.

### Вариант 2: MinGW-w64 (Кросс-компиляция с Linux или на Windows)
64-битная сборка:
```bash
make win64
# Результат: bin/noc-agent-x64.exe
```

32-битная сборка (для устаревших касс Windows POSReady 7 / Windows 7 x86):
```bash
make win32
# Результат: bin/noc-agent-x86.exe
```

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
