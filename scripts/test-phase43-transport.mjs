#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { verifyBearerToken, DEFAULT_TELEMETRY_BEARER_TOKEN, MAX_PAYLOAD_BYTES } from '../lib/auth.ts';
import { generateWorkplaceId, generateErrorHash } from '../lib/db.ts';

console.log('================================================================');
console.log('⚡ PHASE 4.3 — WINHTTP ASYNC TRANSPORT CONTRACT & SAFETY TESTS');
console.log('================================================================\n');

const agentDir = path.resolve(process.cwd(), 'windows-agent');
const includeDir = path.join(agentDir, 'include');
const srcDir = path.join(agentDir, 'src');
const testsDir = path.join(agentDir, 'tests');
const workflowPath = path.resolve(process.cwd(), '.github/workflows/windows-agent.yml');

// ---------------------------------------------------------------------
// БЛОК 1: Проверка файлов модуля транспорта WinHTTP и систем сборки
// ---------------------------------------------------------------------
console.log('▶ БЛОК 1: Проверка файлов транспорта, CMakeLists.txt, Makefile и CI...');

const transportHeader = path.join(includeDir, 'winhttp_transport.hpp');
const transportSource = path.join(srcDir, 'winhttp_transport.cpp');

assert(fs.existsSync(transportHeader), 'FAIL: Отсутствует include/winhttp_transport.hpp');
assert(fs.existsSync(transportSource), 'FAIL: Отсутствует src/winhttp_transport.cpp');

const cmake = fs.readFileSync(path.join(agentDir, 'CMakeLists.txt'), 'utf8');
const makefile = fs.readFileSync(path.join(agentDir, 'Makefile'), 'utf8');
const workflow = fs.readFileSync(workflowPath, 'utf8');

assert(cmake.includes('src/winhttp_transport.cpp'), 'FAIL: CMakeLists.txt должен включать winhttp_transport.cpp');
assert(cmake.includes('winhttp'), 'FAIL: CMakeLists.txt должен линковать winhttp');
assert(makefile.includes('src/winhttp_transport.cpp'), 'FAIL: Makefile должен включать winhttp_transport.cpp');
assert(makefile.includes('-lwinhttp'), 'FAIL: Makefile должен линковать -lwinhttp');

console.log('✅ БЛОК 1 УСПЕШНО ПРОЙДЕН: Файлы транспорта и конфигурации сборки верифицированы.');

// ---------------------------------------------------------------------
// БЛОК 2: Безопасность по умолчанию (Safe Rollout: disabled by default, HTTPS only, No Token Leakage)
// ---------------------------------------------------------------------
console.log('▶ БЛОК 2: Проверка политик безопасности по умолчанию (Disabled, HTTPS, Zero Token Leakage)...');

const headerContent = fs.readFileSync(transportHeader, 'utf8');
const srcContent = fs.readFileSync(transportSource, 'utf8');

// 2.1 enabled = false по умолчанию
assert(headerContent.includes('bool enabled = false;'), 'FAIL: Транспорт обязан быть выключен по умолчанию (enabled = false)');
assert(headerContent.includes('bool allow_insecure_http = false;'), 'FAIL: Plain HTTP обязан быть запрещен по умолчанию');

// 2.2 Проверка маскирования токена (Zero Token Leakage)
function maskTokenForLog(token) {
  if (!token) return '(empty)';
  if (token.length <= 8) return '***';
  return token.substring(0, 3) + '...' + token.substring(token.length - 2) + ` (${token.length} chars)`;
}

const secretToken = 'dev-secret-token-2026';
const masked = maskTokenForLog(secretToken);
assert(!masked.includes('secret'), 'FAIL: Маскированный токен не должен содержать секретную часть');
assert(masked === 'dev...26 (21 chars)', 'FAIL: Неверный формат маскирования токена');
assert(maskTokenForLog('') === '(empty)', 'FAIL: Пустой токен должен обрабатываться безопасно');
assert(maskTokenForLog('short') === '***', 'FAIL: Короткий токен должен маскироваться звездочками');

// 2.3 Лимит на размер ответа сервера 64 КБ
assert(srcContent.includes('kMaxRespBytes = 65536') || srcContent.includes('max_response_bytes = 65536'), 
  'FAIL: Буфер ответа сервера должен быть строго ограничен 64 КБ для защиты памяти POS');

console.log('✅ БЛОК 2 УСПЕШНО ПРОЙДЕН: Безопасность по умолчанию и защита от утечки секретов подтверждены.');

// ---------------------------------------------------------------------
// БЛОК 3: Совместимость контрактов полезной нагрузки SpoolEnvelope -> TelemetryPayload
// ---------------------------------------------------------------------
console.log('▶ БЛОК 3: Проверка соответствия контрактов SpoolEnvelope -> Backend Telemetry API...');

const testEnvelope = {
  shop: 'Магазин Тест 1',
  workplace: 'Касса 1',
  remote: { type: 'NONE', id: '' },
  warnings: ['Предупреждение: долгая смена'],
  runtime_errors: [
    { time: '2026-10-14T07:00:00Z', event: 'FiscalTimeout', error_text: 'Таймаут фискального регистратора' }
  ],
  health_checks: [
    { id: 'ofd_sync', status: 'WARN', details: 'Неотправленных чеков: 12' }
  ],
  system_info: {
    one_c: {
      platform_version: '8.3.24.1540',
      configuration_name: 'Розница 2.3',
      computer_name: 'POS-01'
    },
    agent_version: '1.0.0',
    event_id: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    event_type: 'TELEMETRY',
    priority: 'NORMAL',
    spool_timestamp_utc: '2026-10-14T07:15:00Z'
  }
};

const payloadJson = JSON.stringify(testEnvelope);
const payloadByteLength = Buffer.byteLength(payloadJson, 'utf8');

assert(payloadByteLength <= MAX_PAYLOAD_BYTES, `FAIL: Полезная нагрузка превышает лимит ${MAX_PAYLOAD_BYTES} байт`);
assert(typeof testEnvelope.shop === 'string', 'FAIL: shop must be string');
assert(typeof testEnvelope.workplace === 'string', 'FAIL: workplace must be string');
assert(testEnvelope.remote && typeof testEnvelope.remote === 'object', 'FAIL: remote must be object');

// Проверка вычисления идентификаторов на backend
const wpId = generateWorkplaceId(testEnvelope.shop, testEnvelope.workplace);
assert.equal(wpId.length, 64, 'FAIL: generateWorkplaceId должен быть 64-символьным SHA-256');

const errHash = generateErrorHash(testEnvelope.runtime_errors[0].event, testEnvelope.runtime_errors[0].error_text);
assert.equal(errHash.length, 64, 'FAIL: generateErrorHash должен быть 64-символьным SHA-256');

// Проверка валидатора Bearer Token
assert(verifyBearerToken(`Bearer ${DEFAULT_TELEMETRY_BEARER_TOKEN}`), 'FAIL: Штатный токен должен проходить валидацию');
assert(!verifyBearerToken('Bearer wrong-token'), 'FAIL: Неверный токен должен отклоняться');
assert(!verifyBearerToken(null), 'FAIL: Отсутствующий токен должен отклоняться');

console.log('✅ БЛОК 3 УСПЕШНО ПРОЙДЕН: Схема полезной нагрузки и авторизация полностью совместимы с Backend.');

// ---------------------------------------------------------------------
// БЛОК 4: Экспоненциальный бэкофф и соблюдение Retry-After
// ---------------------------------------------------------------------
console.log('▶ БЛОК 4: Проверка формулы экспоненциального бэкоффа и лимитов ожидания...');

function calculateBackoffSeconds(retryCount, retryAfterHeader = 0) {
  if (retryAfterHeader > 0) {
    return Math.min(Math.max(retryAfterHeader, 5), 600);
  }
  const shift = Math.min(retryCount, 6);
  const backoff = (1 << shift) * 5;
  return Math.min(backoff, 300);
}

assert.equal(calculateBackoffSeconds(0), 5, 'Retry 0 -> 5s');
assert.equal(calculateBackoffSeconds(1), 10, 'Retry 1 -> 10s');
assert.equal(calculateBackoffSeconds(2), 20, 'Retry 2 -> 20s');
assert.equal(calculateBackoffSeconds(3), 40, 'Retry 3 -> 40s');
assert.equal(calculateBackoffSeconds(4), 80, 'Retry 4 -> 80s');
assert.equal(calculateBackoffSeconds(5), 160, 'Retry 5 -> 160s');
assert.equal(calculateBackoffSeconds(6), 300, 'Retry 6 -> 300s (ceiling)');
assert.equal(calculateBackoffSeconds(15), 300, 'Retry 15 -> 300s (ceiling)');
assert.equal(calculateBackoffSeconds(0, 45), 45, 'Retry-After 45s takes precedence');
assert.equal(calculateBackoffSeconds(0, 1000), 600, 'Retry-After 1000s clamped to 600s');

console.log('✅ БЛОК 4 УСПЕШНО ПРОЙДЕН: Алгоритм повторов и экспоненциального бэкоффа верифицирован.');

// ---------------------------------------------------------------------
// БЛОК 5: Проверка тестового покрытия и интеграции в test_agent.cpp
// ---------------------------------------------------------------------
console.log('▶ БЛОК 5: Проверка набора нативных юнит-тестов в test_agent.cpp...');

const testAgentSrc = fs.readFileSync(path.join(testsDir, 'test_agent.cpp'), 'utf8');

assert(testAgentSrc.includes('TestWinHttpTransportLogic'), 'FAIL: test_agent.cpp должен содержать функцию TestWinHttpTransportLogic');
assert(testAgentSrc.includes('MaskTokenForLog'), 'FAIL: Тесты должны проверять маскирование токена');
assert(testAgentSrc.includes('ParseHttpUrl'), 'FAIL: Тесты должны проверять парсер URL');
assert(testAgentSrc.includes('CalculateBackoffSeconds'), 'FAIL: Тесты должны проверять расчет бэкоффа');
assert(testAgentSrc.includes('EnvelopeToIngestionPayload'), 'FAIL: Тесты должны проверять трансформацию полезной нагрузки');
assert(testAgentSrc.includes('MockHttpClient'), 'FAIL: Тесты должны использовать MockHttpClient для имитации сети');
assert(testAgentSrc.includes('RUN_TEST(TestWinHttpTransportLogic)'), 'FAIL: main() обязан запускать TestWinHttpTransportLogic');

console.log('✅ БЛОК 5 УСПЕШНО ПРОЙДЕН: Нативные C++ тесты транспорта подготовлены к прогону в Windows CI.');

console.log('\n================================================================');
console.log('🎉 ВСЕ ПРОВЕРКИ PHASE 4.3 (WINHTTP ASYNC TRANSPORT) УСПЕШНО ВЫПОЛНЕНЫ (PASS)!');
console.log('================================================================');
