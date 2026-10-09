import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import process from 'node:process';

const DB_FILE_PATH = path.resolve(process.cwd(), 'storage.db');
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const ENDPOINT = `${BASE_URL}/api/v1/telemetry`;
const VALID_TOKEN = process.env.TELEMETRY_BEARER_TOKEN || 'dev-secret-token-2026';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[ASSERTION FAILED]: ${message}`);
  }
}

async function runTestSuite() {
  console.log(`\n========================================`);
  console.log(`🧪 NOC DASHBOARD — ENDPOINT TEST RUNNER`);
  console.log(`Target: ${ENDPOINT}`);
  console.log(`========================================\n`);

  const db = new DatabaseSync(DB_FILE_PATH);

  try {
    // ---------------------------------------------------------
    // ТЕСТ 1: Неверный или отсутствующий токен -> HTTP 401
    // ---------------------------------------------------------
    console.log(`▶ ТЕСТ 1: Проверка аутентификации (без токена и с инвалидным токеном)...`);

    // 1.1 Без заголовка Authorization
    const resNoAuth = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop: 'Shop 1', workplace: 'POS 1', remote: { type: 'NONE', id: '' } }),
    });
    console.log(`   - Без заголовка Authorization: HTTP ${resNoAuth.status}`);
    assert(resNoAuth.status === 401, `Ожидался статус 401, получен ${resNoAuth.status}`);

    // 1.2 С неверным токеном
    const resWrongToken = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid-token-xyz',
      },
      body: JSON.stringify({ shop: 'Shop 1', workplace: 'POS 1', remote: { type: 'NONE', id: '' } }),
    });
    console.log(`   - С неверным токеном: HTTP ${resWrongToken.status}`);
    assert(resWrongToken.status === 401, `Ожидался статус 401, получен ${resWrongToken.status}`);
    console.log(`✅ ТЕСТ 1 УСПЕШНО ПРОЙДЕН: 401 Unauthorized возвращен корректно.\n`);

    // ---------------------------------------------------------
    // ТЕСТ 2: Валидный пакет с 1 новой ошибкой -> HTTP 200
    // ---------------------------------------------------------
    console.log(`▶ ТЕСТ 2: Отправка валидного пакета с 1 ошибкой...`);
    const testShop = `Тестовый Магазин 42 [${Date.now()}]`;
    const testWorkplace = 'Касса №1 Основная';
    const uniqueErrorText = `Исключение при печати фискального чека ФР-01: Таймаут порта COM3 [UID-${Date.now()}]`;

    const payloadTest2 = {
      shop: testShop,
      workplace: testWorkplace,
      remote: {
        type: 'ANYDESK',
        id: '992144512',
      },
      system_info: {
        os: 'Windows 10 Pro',
        ram_gb: 8,
        platform_version: '8.3.24.1548',
      },
      warnings: ['Бумага в ККТ подходит к концу (менее 10%)'],
      runtime_errors: [
        {
          time: new Date().toISOString(),
          event: 'ККТ_ОшибкаПечатиЧека',
          error_text: uniqueErrorText,
        },
      ],
      health_checks: [
        {
          id: 'ping_utm',
          name: 'Связь с УТМ ЕГАИС',
          status: 'OK',
          details: 'Ответ 200 OK за 12мс',
        },
      ],
    };

    const resValid = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify(payloadTest2),
    });

    console.log(`   - Статус ответа: HTTP ${resValid.status}`);
    assert(resValid.status === 200, `Ожидался статус 200, получен ${resValid.status}`);

    const dataValid = await resValid.json();
    console.log(`   - Ответ сервера:`, dataValid);
    assert(dataValid.success === true, 'Ожидалось success: true');
    assert(Boolean(dataValid.workplace_id), 'Ожидался непустой workplace_id');
    assert(dataValid.incidents_recorded === 1, `Ожидался incidents_recorded = 1, получено ${dataValid.incidents_recorded}`);

    // Проверяем состояние в базе данных SQLite
    const wpInDb = db.prepare('SELECT * FROM workplaces WHERE id = ?').get(dataValid.workplace_id);
    assert(Boolean(wpInDb), 'Рабочее место не найдено в таблице workplaces');
    assert(wpInDb.remote_id === '992144512', 'remote_id не совпадает в БД');
    assert(wpInDb.remote_type === 'ANYDESK', 'remote_type не совпадает в БД');

    const incidentsInDb = db
      .prepare('SELECT * FROM incidents WHERE workplace_id = ? AND raw_error = ?')
      .all(dataValid.workplace_id, uniqueErrorText);

    assert(incidentsInDb.length === 1, `Ожидался ровно 1 инцидент, найдено: ${incidentsInDb.length}`);
    assert(incidentsInDb[0].occurrences_count === 1, `occurrences_count должен быть 1, получено ${incidentsInDb[0].occurrences_count}`);
    assert(incidentsInDb[0].status === 'ACTIVE', 'Статус инцидента должен быть ACTIVE');
    console.log(`✅ ТЕСТ 2 УСПЕШНО ПРОЙДЕН: Рабочее место создано, инцидент сохранен с occurrences_count = 1.\n`);

    // ---------------------------------------------------------
    // ТЕСТ 3: Повторная отправка того же пакета (Идемпотентность / Дедупликация)
    // ---------------------------------------------------------
    console.log(`▶ ТЕСТ 3: Повторная отправка идентичной ошибки (проверка дедупликации)...`);
    const resDuplicate = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify(payloadTest2),
    });

    console.log(`   - Статус ответа: HTTP ${resDuplicate.status}`);
    assert(resDuplicate.status === 200, `Ожидался статус 200, получен ${resDuplicate.status}`);

    const incidentsAfterDedup = db
      .prepare('SELECT * FROM incidents WHERE workplace_id = ? AND raw_error = ?')
      .all(dataValid.workplace_id, uniqueErrorText);

    console.log(`   - Инцидентов в базе с данной ошибкой: ${incidentsAfterDedup.length}`);
    console.log(`   - occurrences_count инцидента: ${incidentsAfterDedup[0]?.occurrences_count}`);

    assert(
      incidentsAfterDedup.length === 1,
      `Количество строк в таблице не должно было увеличиться! Ожидалось 1, получено ${incidentsAfterDedup.length}`
    );
    assert(
      incidentsAfterDedup[0].occurrences_count === 2,
      `occurrences_count должен инкрементироваться до 2, получено ${incidentsAfterDedup[0].occurrences_count}`
    );
    console.log(`✅ ТЕСТ 3 УСПЕШНО ПРОЙДЕН: Дублирующая строка не создана, счетчик увеличен до 2.\n`);

    // ---------------------------------------------------------
    // ТЕСТ 4: Отправка пакета размером > 64 КБ (Payload Guard) -> HTTP 413
    // ---------------------------------------------------------
    console.log(`▶ ТЕСТ 4: Проверка ограничения размера пакета (> 64 КБ)...`);
    const largeDummyText = 'X'.repeat(70 * 1024); // 70 КБ данных
    const payloadTooLarge = {
      shop: 'Huge Shop',
      workplace: 'Huge POS',
      remote: { type: 'NONE', id: '' },
      warnings: [],
      runtime_errors: [
        {
          time: new Date().toISOString(),
          event: 'OversizedEvent',
          error_text: largeDummyText,
        },
      ],
    };

    const serializedLarge = JSON.stringify(payloadTooLarge);
    const largeByteSize = Buffer.byteLength(serializedLarge, 'utf8');
    console.log(`   - Отправка пакета размером: ${(largeByteSize / 1024).toFixed(2)} КБ`);

    const resTooLarge = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(largeByteSize),
        Authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: serializedLarge,
    });

    console.log(`   - Статус ответа: HTTP ${resTooLarge.status}`);
    assert(
      resTooLarge.status === 413,
      `Ожидался статус 413 Payload Too Large, получен ${resTooLarge.status}`
    );
    console.log(`✅ ТЕСТ 4 УСПЕШНО ПРОЙДЕН: 413 Payload Too Large возвращен корректно.\n`);

    console.log(`========================================`);
    console.log(`🎉 ВСЕ 4 СКВОЗНЫХ ТЕСТА УСПЕШНО ПРОЙДЕНЫ!`);
    console.log(`========================================\n`);
  } finally {
    db.close();
  }
}

runTestSuite().catch((err) => {
  console.error('\n❌ ОШИБКА ПРИ ТЕСТИРОВАНИИ:', err);
  process.exit(1);
});
