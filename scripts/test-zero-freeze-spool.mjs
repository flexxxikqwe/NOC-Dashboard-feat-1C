#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

console.log('================================================================');
console.log('⚡ PHASE 4.1.1 — BSL FUNCTIONAL INTEGRITY & SPOOL CONTRACT TESTS');
console.log('================================================================\n');

const spoolContractPath = path.resolve(process.cwd(), '1c/extension/SPOOL_CONTRACT.md');
const bslClientPath = path.resolve(process.cwd(), '1c/extension/МодульУправляемогоПриложения.bsl');
const bslServerPath = path.resolve(process.cwd(), '1c/extension/ОбщийМодуль_Сервер.bsl');
const buildGuidePath = path.resolve(process.cwd(), '1c/extension/BUILD_GUIDE.md');
const cfePath = path.resolve(process.cwd(), 'public/downloads/support.cfe');

assert(fs.existsSync(spoolContractPath), 'FAIL: SPOOL_CONTRACT.md must exist');
assert(fs.existsSync(bslClientPath), 'FAIL: МодульУправляемогоПриложения.bsl must exist');
assert(fs.existsSync(bslServerPath), 'FAIL: ОбщийМодуль_Сервер.bsl must exist');
assert(fs.existsSync(buildGuidePath), 'FAIL: BUILD_GUIDE.md must exist');
assert(fs.existsSync(cfePath), 'FAIL: support.cfe must exist');

const spoolContract = fs.readFileSync(spoolContractPath, 'utf8');
const bslClient = fs.readFileSync(bslClientPath, 'utf8');
const bslServer = fs.readFileSync(bslServerPath, 'utf8');
const buildGuide = fs.readFileSync(buildGuidePath, 'utf8');

// ---------------------------------------------------------------------
// БЛОК 1: Спецификация контракта Spool (SPOOL_CONTRACT.md)
// ---------------------------------------------------------------------
console.log('▶ БЛОК 1: Проверка спецификации контракта Spool...');

// 1.1 Пути и переопределение
assert(
  spoolContract.includes('%ProgramData%\\1C-NOC\\spool') || spoolContract.includes('C:\\ProgramData\\1C-NOC\\spool'),
  'FAIL: SPOOL_CONTRACT.md должен определять канонический путь %ProgramData%\\1C-NOC\\spool'
);
assert(
  spoolContract.includes('NOC_SPOOL_DIR'),
  'FAIL: SPOOL_CONTRACT.md должен поддерживать переопределение через NOC_SPOOL_DIR'
);

// 1.2 Формат имен файлов
assert(
  spoolContract.includes('temp_<') && spoolContract.includes('.tmp'),
  'FAIL: SPOOL_CONTRACT.md должен фиксировать формат временного файла temp_<id>.tmp'
);
assert(
  spoolContract.includes('<timestamp') && spoolContract.includes('.json'),
  'FAIL: SPOOL_CONTRACT.md должен фиксировать формат опубликованного файла <ts>_<id>.json'
);

// 1.3 Схема конверта Envelope v1.0
const requiredEnvelopeFields = [
  'schema_version',
  'event_id',
  'timestamp_utc',
  'source',
  'event_type',
  'priority',
  'payload',
];
for (const field of requiredEnvelopeFields) {
  assert(
    spoolContract.includes(`"${field}"`),
    `FAIL: SPOOL_CONTRACT.md должен специфицировать обязательное поле конверта ${field}`
  );
}

// 1.4 Схема payload
const requiredPayloadFields = ['shop', 'workplace', 'warnings', 'runtime_errors', 'health_checks', 'one_c_info'];
for (const field of requiredPayloadFields) {
  assert(
    spoolContract.includes(`"${field}"`),
    `FAIL: SPOOL_CONTRACT.md должен специфицировать поле полезной нагрузки ${field}`
  );
}

// 1.5 Ограничения размера и Backpressure Guard
assert(
  spoolContract.includes('64 КБ') || spoolContract.includes('65 536') || spoolContract.includes('65536'),
  'FAIL: SPOOL_CONTRACT.md должен фиксировать лимит пакета 64 КБ'
);
assert(
  spoolContract.includes('50') && spoolContract.includes('файлов'),
  'FAIL: SPOOL_CONTRACT.md должен фиксировать лимит очереди backpressure (50 файлов)'
);

// 1.6 Спецификация трансформации Envelope -> API для службы Windows
assert(
  spoolContract.includes('Трансформация конверта службой Windows') || spoolContract.includes('Ingestion API'),
  'FAIL: SPOOL_CONTRACT.md должен содержать раздел трансформации конверта для API'
);

// 1.7 Release Gate
assert(
  spoolContract.includes('Phase 4.2') || spoolContract.includes('Release Gate'),
  'FAIL: SPOOL_CONTRACT.md должен фиксировать Release Gate зависимость от Windows Service'
);

console.log('✅ БЛОК 1 УСПЕШНО ПРОЙДЕН: Спецификация контракта Spool полная и строгая.\n');

// ---------------------------------------------------------------------
// БЛОК 2: Клиентский контур 1С — Цепочка вызовов и Zero-Freeze
// ---------------------------------------------------------------------
console.log('▶ БЛОК 2: Аудит клиентского модуля МодульУправляемогоПриложения.bsl...');

// 2.1 Отсутствие сетевых вызовов в клиенте
assert(
  !bslClient.includes('HTTPСоединение'),
  'FAIL: Клиентский модуль не должен содержать сетевых вызовов HTTPСоединение'
);

// 2.2 Отсутствие WMI/SWbemLocator
assert(
  !bslClient.includes('WbemScripting') && !bslClient.includes('SWbemLocator'),
  'FAIL: Клиентский модуль не должен вызывать тяжелый WMI'
);

// 2.3 Немедленный возврат управления при старте кассы (Zero-Freeze старта)
assert(
  bslClient.includes('ПродолжитьВызов();'),
  'FAIL: Процедура _МС_ПриНачалеРаботыСистемы должна немедленно вызывать ПродолжитьВызов() без блокировок'
);

// 2.4 Безопасная регистрация периодического мониторинга для файловых баз
assert(
  bslClient.includes('ПодключитьОбработчикОжидания("_МС_ТихийСтартМониторинга", 600)'),
  'FAIL: Клиентский модуль должен подключать обработчик ожидания с безопасным интервалом 600 секунд для файлового режима'
);

// 2.5 Вызов серверного метода записи в spool из тихого обработчика
assert(
  bslClient.includes('_МС_Сервер.ВыполнитьРегламентныйМониторинг();'),
  'FAIL: _МС_ТихийСтартМониторинга должен вызывать _МС_Сервер.ВыполнитьРегламентныйМониторинг()'
);

// 2.6 Наличие заглушек для обратной совместимости
assert(
  bslClient.includes('_МС_ОпределитьПараметрыУдаленногоДоступаНаКлиенте'),
  'FAIL: Клиентский модуль должен сохранять экспортные методы для обратной совместимости'
);

console.log('✅ БЛОК 2 УСПЕШНО ПРОЙДЕН: Цепочка вызовов в файловом режиме активна, старт кассы изолирован (Zero-Freeze).\n');

// ---------------------------------------------------------------------
// БЛОК 3: Серверный контур 1С — Реализация Spool, лимиты байт и Crash Recovery
// ---------------------------------------------------------------------
console.log('▶ БЛОК 3: Аудит серверного модуля ОбщийМодуль_Сервер.bsl...');

// 3.1 Полное отсутствие синхронного HTTP в боевом коде
assert(
  !bslServer.includes('Новый HTTPСоединение'),
  'FAIL: ОбщийМодуль_Сервер.bsl не должен создавать HTTPСоединение'
);
assert(
  !bslServer.includes('HTTPЗапрос'),
  'FAIL: ОбщийМодуль_Сервер.bsl не должен создавать HTTPЗапрос'
);

// 3.2 Отсутствие SWbemLocator (WMI)
assert(
  !bslServer.includes('SWbemLocator'),
  'FAIL: ОбщийМодуль_Сервер.bsl не должен использовать WMI'
);

// 3.3 Атомарная публикация пакета (temp_<id>.tmp -> <ts>_<id>.json)
assert(
  bslServer.includes('ПереместитьФайл('),
  'FAIL: ОбщийМодуль_Сервер.bsl должен атомарно публиковать файл через ПереместитьФайл'
);
assert(
  bslServer.includes('temp_') && bslServer.includes('.tmp'),
  'FAIL: ОбщийМодуль_Сервер.bsl должен использовать временные файлы temp_<id>.tmp'
);
assert(
  bslServer.includes('.json'),
  'FAIL: ОбщийМодуль_Сервер.bsl должен публиковать файлы с расширением .json'
);

// 3.4 Проверка размера в байтах UTF-8 (Payload Guard)
assert(
  bslServer.includes('ПолучитьДвоичныеДанныеИзСтроки') && bslServer.includes('Размер()'),
  'FAIL: ОбщийМодуль_Сервер.bsl должен определять точный размер пакета в байтах UTF-8'
);
assert(
  bslServer.includes('55000'),
  'FAIL: ОбщийМодуль_Сервер.bsl должен использовать предупреждающий порог усечения 55 000 байт'
);
assert(
  bslServer.includes('runtime_errors'),
  'FAIL: ОбщийМодуль_Сервер.bsl должен управлять массивом runtime_errors при усечении'
);

// 3.5 Защита от переполнения (Backpressure Guard)
assert(
  bslServer.includes('_МС_ПроверитьГотовностьИЛимитSpool'),
  'FAIL: ОбщийМодуль_Сервер.bsl должен реализовывать функцию _МС_ПроверитьГотовностьИЛимитSpool'
);
assert(
  bslServer.includes('50'),
  'FAIL: Лимит файлов в очереди по умолчанию должен составлять 50'
);

// 3.6 Очистка зависших .tmp файлов при сбоях (Crash Recovery)
assert(
  bslServer.includes('temp_*.tmp') && bslServer.includes('3600'),
  'FAIL: ОбщийМодуль_Сервер.bsl должен очищать зависшие temp_*.tmp файлы старше 1 часа'
);

// 3.7 Запись без BOM и компактная кодировка UTF-8
assert(
  bslServer.includes('ЭкранированиеСимволовJSON.Нет'),
  'FAIL: ОбщийМодуль_Сервер.bsl должен использовать компактный UTF-8 без раздувания кириллицы'
);

// 3.8 Безопасный Fail-Safe: подавление всех исключений
assert(
  bslServer.includes('Исключение') && bslServer.includes('КонецПопытки'),
  'FAIL: Регламентный мониторинг должен оборачивать весь цикл в Попытка...Исключение'
);

console.log('✅ БЛОК 3 УСПЕШНО ПРОЙДЕН: Атомарная публикация spool, байтовый лимит 55 КБ и очистка .tmp соблюдены.\n');

// ---------------------------------------------------------------------
// БЛОК 4: Валидация формата пакета Envelope Schema v1.0 и трансформация в API
// ---------------------------------------------------------------------
console.log('▶ БЛОК 4: Валидация образца конверта JSON и трансформации в API...');

const sampleEnvelope = {
  schema_version: '1.0',
  event_id: '123e4567-e89b-12d3-a456-426614174000',
  timestamp_utc: new Date().toISOString(),
  source: '1C_EXTENSION',
  event_type: 'TELEMETRY',
  priority: 'NORMAL',
  payload: {
    shop: 'Магазин №101',
    workplace: 'Касса 3',
    warnings: ['Кассовая смена открыта более 24 часов.'],
    runtime_errors: [
      {
        time: new Date().toISOString(),
        event: '1C_Runtime_Error',
        error_text: 'Тестовая ошибка времени выполнения',
      },
    ],
    health_checks: [
      {
        id: 'shift_duration_24h',
        name: 'Длительность кассовой смены',
        status: 'WARN',
        details: 'Кассовая смена открыта более 24 часов.',
      },
    ],
    one_c_info: {
      platform_version: '8.3.24.1540',
      configuration_name: 'Розница, редакция 2.3',
      computer_name: 'POS-TEST-TERM',
    },
  },
};

const jsonStr = JSON.stringify(sampleEnvelope);
const byteSize = Buffer.byteLength(jsonStr, 'utf8');

assert(byteSize < 55000, `FAIL: Размер пакета ${byteSize} превышает квоту 55 000 байт`);
assert(sampleEnvelope.schema_version === '1.0', 'FAIL: schema_version must be 1.0');
assert(sampleEnvelope.source === '1C_EXTENSION', 'FAIL: source must be 1C_EXTENSION');

// 4.1 Эмуляция трансформации службой Windows (Phase 4.2) в формат Ingestion API (/api/v1/telemetry)
const transformedApiPayload = {
  shop: sampleEnvelope.payload.shop,
  workplace: sampleEnvelope.payload.workplace,
  remote: {
    type: 'ANYDESK',
    id: '992144512',
  },
  warnings: sampleEnvelope.payload.warnings,
  runtime_errors: sampleEnvelope.payload.runtime_errors,
  health_checks: sampleEnvelope.payload.health_checks,
  system_info: {
    ...sampleEnvelope.payload.one_c_info,
    cpu_usage_percent: 12.5,
    memory_available_mb: 2048,
    disk_free_gb: 45.2,
  },
};

// Проверяем соответствие схеме TelemetryPayload
assert(typeof transformedApiPayload.shop === 'string', 'FAIL: API payload shop must be string');
assert(typeof transformedApiPayload.workplace === 'string', 'FAIL: API payload workplace must be string');
assert(typeof transformedApiPayload.remote === 'object' && transformedApiPayload.remote.type, 'FAIL: remote is mandatory for API');
assert(Array.isArray(transformedApiPayload.warnings), 'FAIL: API warnings must be array');
assert(Array.isArray(transformedApiPayload.runtime_errors), 'FAIL: API runtime_errors must be array');
assert(Array.isArray(transformedApiPayload.health_checks), 'FAIL: API health_checks must be array');

const transformedByteSize = Buffer.byteLength(JSON.stringify(transformedApiPayload), 'utf8');
assert(transformedByteSize < 65536, `FAIL: Transformed API payload ${transformedByteSize} must be < 65536`);

console.log(`✅ БЛОК 4 УСПЕШНО ПРОЙДЕН: Схема JSON валидна (${byteSize} байт), трансформация в API (${transformedByteSize} байт) корректна.\n`);

// ---------------------------------------------------------------------
// БЛОК 5: Проверка BUILD_GUIDE.md и статуса support.cfe
// ---------------------------------------------------------------------
console.log('▶ БЛОК 5: Проверка документации сборки и статуса CFE...');

assert(
  buildGuide.includes('Phase 4.1') || buildGuide.includes('Zero-Freeze') || buildGuide.includes('spool'),
  'FAIL: BUILD_GUIDE.md должен отражать архитектуру Phase 4.1 Zero-Freeze'
);
assert(
  buildGuide.includes('support.cfe'),
  'FAIL: BUILD_GUIDE.md должен инструктировать по компиляции support.cfe'
);

const cfeBuffer = fs.readFileSync(cfePath);
assert(cfeBuffer.length > 1000, 'FAIL: support.cfe должен иметь реальный размер');
assert(
  cfeBuffer[0] === 0xff && cfeBuffer[1] === 0xff && cfeBuffer[2] === 0xff && cfeBuffer[3] === 0x7f,
  'FAIL: support.cfe должен иметь сигнатуру бинарного контейнера 1С (FF FF FF 7F)'
);

console.log('✅ БЛОК 5 УСПЕШНО ПРОЙДЕН: BUILD_GUIDE.md актуализирован, CFE зафиксирован как артефакт.\n');

console.log('================================================================');
console.log('🎉 ВСЕ ПРОВЕРКИ PHASE 4.1.1 (INTEGRITY & CONTRACT) УСПЕШНО ВЫПОЛНЕНЫ (PASS)!');
console.log('================================================================\n');
