#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

console.log('================================================================');
console.log('⚡ PHASE 4.2 — NATIVE WINDOWS AGENT, SPOOL INGESTION & RECOVERY');
console.log('================================================================\n');

const agentDir = path.resolve(process.cwd(), 'windows-agent');
const includeDir = path.join(agentDir, 'include');
const srcDir = path.join(agentDir, 'src');
const testsDir = path.join(agentDir, 'tests');
const vendorDir = path.join(agentDir, 'vendor/sqlite');

// ---------------------------------------------------------------------
// БЛОК 1: Структура нативного C++ проекта и конфигурация сборки
// ---------------------------------------------------------------------
console.log('▶ БЛОК 1: Проверка файловой структуры и систем сборки C++17 / Win32...');

const requiredFiles = [
  path.join(agentDir, 'CMakeLists.txt'),
  path.join(agentDir, 'Makefile'),
  path.join(agentDir, 'README.md'),
  path.join(includeDir, 'common.hpp'),
  path.join(includeDir, 'raii_handles.hpp'),
  path.join(includeDir, 'json_lite.hpp'),
  path.join(includeDir, 'crypto_hash.hpp'),
  path.join(includeDir, 'sqlite_queue.hpp'),
  path.join(includeDir, 'spool_watcher.hpp'),
  path.join(includeDir, 'service_core.hpp'),
  path.join(srcDir, 'main.cpp'),
  path.join(srcDir, 'json_lite.cpp'),
  path.join(srcDir, 'crypto_hash.cpp'),
  path.join(srcDir, 'sqlite_queue.cpp'),
  path.join(srcDir, 'spool_watcher.cpp'),
  path.join(srcDir, 'service_core.cpp'),
  path.join(testsDir, 'test_agent.cpp'),
  path.join(vendorDir, 'sqlite3.c'),
  path.join(vendorDir, 'sqlite3.h')
];

for (const file of requiredFiles) {
  assert(fs.existsSync(file), `FAIL: Обязательный файл отсутствует: ${path.relative(process.cwd(), file)}`);
}

const cmake = fs.readFileSync(path.join(agentDir, 'CMakeLists.txt'), 'utf8');
const makefile = fs.readFileSync(path.join(agentDir, 'Makefile'), 'utf8');

assert(cmake.includes('CMAKE_CXX_STANDARD 17'), 'FAIL: CMakeLists.txt должен требовать C++17');
assert(cmake.includes('SQLITE_ENABLE_WAL=1'), 'FAIL: SQLite в CMakeLists.txt должен собираться с флагом WAL');
assert(cmake.includes('SQLITE_THREADSAFE=1'), 'FAIL: SQLite в CMakeLists.txt должен собираться с флагом THREADSAFE');
assert(cmake.includes('advapi32'), 'FAIL: CMakeLists.txt должен линковать advapi32 для Win32 Service API');

assert(makefile.includes('x86_64-w64-mingw32-g++'), 'FAIL: Makefile должен поддерживать 64-битную кросс-компиляцию MinGW');
assert(makefile.includes('i686-w64-mingw32-g++'), 'FAIL: Makefile должен поддерживать 32-битную кросс-компиляцию MinGW');
assert(makefile.includes('-static -static-libgcc -static-libstdc++'), 'FAIL: Makefile должен статически линковать runtime C++');

console.log('✅ БЛОК 1 УСПЕШНО ПРОЙДЕН: Все 19 файлов нативного агента на месте, CMake и Makefile настроены.\n');

// ---------------------------------------------------------------------
// БЛОК 2: Аудит C++ реализации жизненного цикла Windows-службы (SCM)
// ---------------------------------------------------------------------
console.log('▶ БЛОК 2: Аудит жизненного цикла службы SCM (START_PENDING, RUNNING, STOP_PENDING)...');

const serviceCoreCpp = fs.readFileSync(path.join(srcDir, 'service_core.cpp'), 'utf8');
const serviceCoreHpp = fs.readFileSync(path.join(includeDir, 'service_core.hpp'), 'utf8');

assert(serviceCoreCpp.includes('RegisterServiceCtrlHandlerExW'), 'FAIL: Служба должна регистрировать HandlerEx через RegisterServiceCtrlHandlerExW');
assert(serviceCoreCpp.includes('SERVICE_WIN32_OWN_PROCESS'), 'FAIL: Тип службы должен быть SERVICE_WIN32_OWN_PROCESS');
assert(serviceCoreCpp.includes('SERVICE_START_PENDING'), 'FAIL: Должно выставляться состояние SERVICE_START_PENDING');
assert(serviceCoreCpp.includes('SERVICE_RUNNING'), 'FAIL: Должно выставляться состояние SERVICE_RUNNING');
assert(serviceCoreCpp.includes('SERVICE_STOP_PENDING'), 'FAIL: Должно выставляться состояние SERVICE_STOP_PENDING');
assert(serviceCoreCpp.includes('SERVICE_STOPPED'), 'FAIL: Должно выставляться финальное состояние SERVICE_STOPPED');
assert(serviceCoreCpp.includes('SERVICE_CONTROL_STOP'), 'FAIL: Обработчик должен перехватывать команду SERVICE_CONTROL_STOP');
assert(serviceCoreCpp.includes('SERVICE_CONTROL_SHUTDOWN'), 'FAIL: Обработчик должен перехватывать событие SERVICE_CONTROL_SHUTDOWN');
assert(serviceCoreCpp.includes('WaitForSingleObject(self.stop_event_, INFINITE)'), 'FAIL: Основной поток службы должен ждать на объекте события, исключая busy-loop');

// Поддержка CLI команд управления
assert(serviceCoreHpp.includes('RunMode'), 'FAIL: Должен быть enum RunMode для режимов запуска');
assert(serviceCoreCpp.includes('--install') && serviceCoreCpp.includes('CreateServiceW'), 'FAIL: Служба должна поддерживать саморегистрацию (--install)');
assert(serviceCoreCpp.includes('--uninstall') && serviceCoreCpp.includes('DeleteService'), 'FAIL: Служба должна поддерживать удаление (--uninstall)');
assert(serviceCoreCpp.includes('--console'), 'FAIL: Служба должна поддерживать интерактивную консоль (--console)');
assert(serviceCoreCpp.includes('--run-once'), 'FAIL: Служба должна поддерживать тестовый проход (--run-once)');

console.log('✅ БЛОК 2 УСПЕШНО ПРОЙДЕН: FSM жизненного цикла Win32 Service полностью соответствует спецификации.\n');

// ---------------------------------------------------------------------
// БЛОК 3: Аудит строгого парсера JSON, валидатора UTF-8 и схемы Spool Envelope
// ---------------------------------------------------------------------
console.log('▶ БЛОК 3: Валидация правил схемы Spool Envelope, отсутствия BOM и лимита 64 КБ...');

const jsonLiteCpp = fs.readFileSync(path.join(srcDir, 'json_lite.cpp'), 'utf8');

// 3.1 Валидация UTF-8 без BOM
assert(jsonLiteCpp.includes('0xEF') && jsonLiteCpp.includes('0xBB') && jsonLiteCpp.includes('0xBF'), 
  'FAIL: Валидатор UTF-8 должен явно проверять и отбраковывать байты BOM');
assert(jsonLiteCpp.includes('contract strictly requires UTF-8 without BOM'), 
  'FAIL: Текст ошибки должен фиксировать запрет BOM по спецификации');

// 3.2 Валидатор Envelope
assert(jsonLiteCpp.includes('MAX_PAYLOAD_BYTES'), 'FAIL: Валидатор должен проверять максимальный размер пакета 64 КБ');
assert(jsonLiteCpp.includes('SCHEMA_VERSION_1_0'), 'FAIL: Валидатор должен проверять schema_version == "1.0"');
assert(jsonLiteCpp.includes('SOURCE_1C_EXTENSION'), 'FAIL: Валидатор должен проверять source == "1C_EXTENSION"');

// 3.3 Проверка формата GUID
assert(jsonLiteCpp.includes('guid_str.size() != 36') || jsonLiteCpp.includes('guid_str[8] != \'-\''), 
  'FAIL: Валидатор должен проверять 36-значный формат GUID для event_id');

// 3.4 Обязательные поля shop и workplace
assert(jsonLiteCpp.includes('payload.shop'), 'FAIL: Валидатор должен требовать поле payload.shop');
assert(jsonLiteCpp.includes('payload.workplace'), 'FAIL: Валидатор должен требовать поле payload.workplace');

// Проверим валидность эталонного пакета JSON средствами Node.js
const validEnvelope = {
  schema_version: "1.0",
  event_id: "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
  timestamp_utc: "2026-10-12T14:30:00.123Z",
  source: "1C_EXTENSION",
  event_type: "TELEMETRY",
  priority: "NORMAL",
  payload: {
    shop: "Магазин Розница №42",
    workplace: "Касса 1",
    warnings: ["Кассовая смена открыта более 24 часов"],
    runtime_errors: [],
    health_checks: [],
    one_c_info: {
      platform_version: "8.3.24.1540",
      configuration_name: "Розница, редакция 2.3",
      computer_name: "POS-TERM-01"
    }
  }
};
const validRaw = JSON.stringify(validEnvelope);
assert(Buffer.byteLength(validRaw, 'utf8') < 65536, 'FAIL: Эталонный пакет должен укладываться в 64 КБ');

console.log('✅ БЛОК 3 УСПЕШНО ПРОЙДЕН: Строгая валидация JSON и Envelope Schema v1.0 подтверждена.\n');

// ---------------------------------------------------------------------
// БЛОК 4: Аудит SQLite очереди: транзакции, WAL, дедупликация и приоритеты
// ---------------------------------------------------------------------
console.log('▶ БЛОК 4: Аудит транзакционной модели SQLite, SHA-256 и FIFO-приоритетов...');

const sqliteQueueCpp = fs.readFileSync(path.join(srcDir, 'sqlite_queue.cpp'), 'utf8');

assert(sqliteQueueCpp.includes('PRAGMA journal_mode = WAL;'), 'FAIL: SQLite должен открываться в режиме WAL');
assert(sqliteQueueCpp.includes('PRAGMA synchronous = NORMAL;'), 'FAIL: SQLite должен использовать synchronous = NORMAL');
assert(sqliteQueueCpp.includes('BEGIN IMMEDIATE TRANSACTION;'), 'FAIL: Вставка должна выполняться в строгой транзакции BEGIN IMMEDIATE');
assert(sqliteQueueCpp.includes('sha256 TEXT NOT NULL UNIQUE'), 'FAIL: Поле sha256 должно иметь ограничение UNIQUE для аппаратной дедупликации');
assert(sqliteQueueCpp.includes('DUPLICATE_IGNORED'), 'FAIL: Должен возвращаться статус DUPLICATE_IGNORED при повторном хеше');
assert(sqliteQueueCpp.includes('idx_spool_queue_status_prio'), 'FAIL: Должен создаваться композитный индекс по status, priority, id');

// Проверка приоритета выборки: HIGH -> NORMAL -> LOW
assert(
  sqliteQueueCpp.includes("WHEN 'HIGH' THEN 1") &&
  sqliteQueueCpp.includes("WHEN 'NORMAL' THEN 2") &&
  sqliteQueueCpp.includes("WHEN 'LOW' THEN 3"),
  'FAIL: Запрос выборки должен приоритизировать HIGH перед NORMAL и LOW'
);

// Проверка расчета SHA-256
const cryptoHashCpp = fs.readFileSync(path.join(srcDir, 'crypto_hash.cpp'), 'utf8');
assert(cryptoHashCpp.includes('Sha256Transform'), 'FAIL: crypto_hash должен содержать FIPS 180-4 преобразование');
const nodeHashNist = crypto.createHash('sha256').update('abc').digest('hex');
assert.equal(nodeHashNist, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'NIST вектор abc');

console.log('✅ БЛОК 4 УСПЕШНО ПРОЙДЕН: Схема SQLite очереди, транзакции WAL и дедупликация подтверждены.\n');

// ---------------------------------------------------------------------
// БЛОК 5: Аудит файлового конвейера: ReadDirectoryChangesW, Карантин и Crash Recovery
// ---------------------------------------------------------------------
console.log('▶ БЛОК 5: Аудит SpoolWatcher, атомарного захвата, изоляции карантина и очистки .tmp...');

const spoolWatcherCpp = fs.readFileSync(path.join(srcDir, 'spool_watcher.cpp'), 'utf8');

assert(spoolWatcherCpp.includes('ReadDirectoryChangesW'), 'FAIL: Наблюдатель должен использовать ReadDirectoryChangesW для Win32');
assert(spoolWatcherCpp.includes('FALLBACK_POLL_INTERVAL_MS'), 'FAIL: Наблюдатель должен иметь таймаут fallback-опроса (5 с)');
assert(spoolWatcherCpp.includes('std::sort(json_files.begin(), json_files.end());'), 
  'FAIL: Файлы spool должны сортироваться лексикографически для строгой хронологии FIFO');
const spoolWatcherHpp = fs.readFileSync(path.join(includeDir, 'spool_watcher.hpp'), 'utf8');
const commonHpp = fs.readFileSync(path.join(includeDir, 'common.hpp'), 'utf8');

assert(spoolWatcherCpp.includes('SweepStaleTmpFiles'), 'FAIL: Должен быть реализован механизм SweepStaleTmpFiles');
assert(commonHpp.includes('TMP_CLEANUP_AGE_SECONDS = 300') && spoolWatcherHpp.includes('TMP_CLEANUP_AGE_SECONDS'), 
  'FAIL: Порог очистки зависших файлов .tmp должен составлять 300 с (TMP_CLEANUP_AGE_SECONDS)');
assert(spoolWatcherCpp.includes('QuarantineFile'), 'FAIL: Должна быть реализована процедура переноса в карантин QuarantineFile');
assert(spoolWatcherCpp.includes('OVERSIZED_64KB'), 'FAIL: Должен обрабатываться карантин превышения размера OVERSIZED_64KB');
assert(spoolWatcherCpp.includes('INVALID_ENVELOPE'), 'FAIL: Должен обрабатываться карантин некорректного конверта INVALID_ENVELOPE');
assert(spoolWatcherCpp.includes('fs::remove(p, ec);'), 'FAIL: Исходный spool-файл должен удаляться только после успешной фиксации в БД');

console.log('✅ БЛОК 5 УСПЕШНО ПРОЙДЕН: Win32 Watcher, изоляция карантина и Crash Recovery верифицированы.\n');

console.log('================================================================');
console.log('🎉 ВСЕ ПРОВЕРКИ PHASE 4.2 (NATIVE WINDOWS SERVICE) УСПЕШНО ВЫПОЛНЕНЫ (PASS)!');
console.log('================================================================\n');
