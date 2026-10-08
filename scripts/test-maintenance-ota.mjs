import Database from 'better-sqlite3';
import path from 'node:path';
import process from 'node:process';

const DB_FILE_PATH = path.resolve(process.cwd(), 'storage.db');
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const VALID_TOKEN = process.env.TELEMETRY_BEARER_TOKEN || 'dev-secret-token-2026';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[ASSERTION FAILED]: ${message}`);
  }
}

async function runMaintenanceOtaTestSuite() {
  console.log(`\n======================================================`);
  console.log(`🧪 NOC DASHBOARD — OTA & MAINTENANCE TEST RUNNER`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`======================================================\n`);

  const db = new Database(DB_FILE_PATH);

  try {
    // --------------------------------------------------------------------------
    // ТЕСТ 1: OTA Version Endpoint (GET /api/v1/version)
    // --------------------------------------------------------------------------
    console.log(`▶ ТЕСТ 1: Проверка эндпоинта версии (GET /api/v1/version)...`);
    const versionUrl = `${BASE_URL}/api/v1/version`;
    const resVersion = await fetch(versionUrl);

    console.log(`   - HTTP Статус: ${resVersion.status}`);
    assert(resVersion.status === 200, `Ожидался статус 200, получен ${resVersion.status}`);

    const cacheControl = resVersion.headers.get('cache-control');
    console.log(`   - Cache-Control: ${cacheControl}`);
    assert(
      cacheControl && cacheControl.includes('no-cache'),
      `Ожидался Cache-Control с no-cache, получено: ${cacheControl}`
    );

    const versionData = await resVersion.json();
    console.log(`   - Данные версии:`, versionData);
    assert(versionData.version === '1.0.0', `Ожидалась версия '1.0.0', получено '${versionData.version}'`);
    assert(versionData.download_url === '/downloads/support.cfe', `Неверный download_url: ${versionData.download_url}`);
    console.log(`✅ ТЕСТ 1 УСПЕШНО ПРОЙДЕН: Эндпоинт версии возвращает 1.0.0 без кэширования.\n`);

    // --------------------------------------------------------------------------
    // ТЕСТ 2: OTA File Download (GET /downloads/support.cfe)
    // --------------------------------------------------------------------------
    console.log(`▶ ТЕСТ 2: Проверка скачивания артефакта расширения (/downloads/support.cfe)...`);
    const downloadUrl = `${BASE_URL}/downloads/support.cfe`;
    const resDownload = await fetch(downloadUrl);

    console.log(`   - HTTP Статус: ${resDownload.status}`);
    assert(resDownload.status === 200, `Ожидался статус 200 при скачивании файла, получен ${resDownload.status}`);

    const downloadedText = await resDownload.text();
    console.log(`   - Размер загруженного файла: ${downloadedText.length} символов`);
    assert(downloadedText.length > 20, 'Файл расширения пустой или поврежден');
    console.log(`✅ ТЕСТ 2 УСПЕШНО ПРОЙДЕН: Файл support.cfe доступен для скачивания кассами.\n`);

    // --------------------------------------------------------------------------
    // ТЕСТ 3: TTL Cleaner Logic (SQLite + POST /api/v1/maintenance/cleanup)
    // --------------------------------------------------------------------------
    console.log(`▶ ТЕСТ 3: Проверка алгоритма очистки устаревших инцидентов (TTL Retention)...`);

    // Создаем тестовое рабочее место
    const testWorkplaceId = 'ttl-test-workplace-' + Date.now();
    db.prepare(`
      INSERT OR REPLACE INTO workplaces (
        id, shop_name, workplace_name, remote_type, remote_id, last_seen
      ) VALUES (?, 'Магазин TTL', 'Касса TTL', 'NONE', NULL, datetime('now'))
    `).run(testWorkplaceId);

    // Подготовка дат: 20 дней назад, 3 дня назад, 25 дней назад
    const date20DaysAgo = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    const date3DaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    const date25DaysAgo = new Date(Date.now() - 25 * 24 * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);

    const insertIncidentStmt = db.prepare(`
      INSERT INTO incidents (
        workplace_id, error_hash, error_type, severity, raw_error, status, created_at, last_occurred_at
      ) VALUES (?, ?, ?, 'ERROR', ?, ?, ?, ?)
    `);

    // Инцидент А: RESOLVED, 20 дней назад -> ДОЛЖЕН БЫТЬ УДАЛЕН
    const infoA = insertIncidentStmt.run(
      testWorkplaceId,
      'hash_a_' + Date.now(),
      'OldResolvedError',
      'Ошибка А (старая закрытая)',
      'RESOLVED',
      date20DaysAgo,
      date20DaysAgo
    );
    const idA = infoA.lastInsertRowid;

    // Инцидент Б: RESOLVED, 3 дня назад -> ДОЛЖЕН ОСТАТЬСЯ
    const infoB = insertIncidentStmt.run(
      testWorkplaceId,
      'hash_b_' + Date.now(),
      'FreshResolvedError',
      'Ошибка Б (свежая закрытая)',
      'RESOLVED',
      date3DaysAgo,
      date3DaysAgo
    );
    const idB = infoB.lastInsertRowid;

    // Инцидент В: ACTIVE, 25 дней назад -> ДОЛЖЕН ОСТАТЬСЯ (ACTIVE никогда не удаляется!)
    const infoV = insertIncidentStmt.run(
      testWorkplaceId,
      'hash_v_' + Date.now(),
      'OldActiveError',
      'Ошибка В (старая активная - требует внимания NOC!)',
      'ACTIVE',
      date25DaysAgo,
      date25DaysAgo
    );
    const idV = infoV.lastInsertRowid;

    console.log(`   - Тестовые записи созданы: Инцидент А (ID ${idA}), Б (ID ${idB}), В (ID ${idV})`);

    // 3.1 Проверка безопасности эндпоинта очистки: без токена -> 401
    const resNoAuthCleanup = await fetch(`${BASE_URL}/api/v1/maintenance/cleanup`, {
      method: 'POST',
    });
    console.log(`   - Вызов очистки без токена: HTTP ${resNoAuthCleanup.status}`);
    assert(resNoAuthCleanup.status === 401, `Ожидался статус 401, получен ${resNoAuthCleanup.status}`);

    // 3.2 Авторизованный запуск очистки через эндпоинт
    const resCleanup = await fetch(`${BASE_URL}/api/v1/maintenance/cleanup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({ retention_days: 14 }),
    });

    console.log(`   - Вызов очистки с токеном: HTTP ${resCleanup.status}`);
    assert(resCleanup.status === 200, `Ожидался статус 200, получен ${resCleanup.status}`);

    const cleanupData = await resCleanup.json();
    console.log(`   - Ответ эндпоинта очистки:`, cleanupData);
    assert(cleanupData.success === true, 'Ожидался success: true');
    assert(cleanupData.deleted_count >= 1, 'Должен быть удален как минимум 1 устаревший инцидент');

    // 3.3 Проверка состояния в базе данных
    const checkStmt = db.prepare('SELECT id, status FROM incidents WHERE id = ?');
    const recordA = checkStmt.get(idA);
    const recordB = checkStmt.get(idB);
    const recordV = checkStmt.get(idV);

    console.log(`   - Проверка наличия в БД после TTL:`);
    console.log(`     * Инцидент А (RESOLVED, 20 дн): ${recordA ? 'ПРИСУТСТВУЕТ (ОШИБКА)' : 'УДАЛЕН (ВЕРНО)'}`);
    console.log(`     * Инцидент Б (RESOLVED, 3 дн):  ${recordB ? 'ПРИСУТСТВУЕТ (ВЕРНО)' : 'УДАЛЕН (ОШИБКА)'}`);
    console.log(`     * Инцидент В (ACTIVE, 25 дн):   ${recordV ? 'ПРИСУТСТВУЕТ (ВЕРНО)' : 'УДАЛЕН (ОШИБКА)'}`);

    assert(!recordA, 'Инцидент А (RESOLVED > 14 дней) должен был быть удален!');
    assert(Boolean(recordB), 'Инцидент Б (RESOLVED < 14 дней) обязан сохраниться!');
    assert(Boolean(recordV), 'Инцидент В (ACTIVE) обязан сохраниться независимо от возраста!');

    console.log(`✅ ТЕСТ 3 УСПЕШНО ПРОЙДЕН: Логика TTL отработала безупречно, активные инциденты защищены.\n`);

    console.log(`======================================================`);
    console.log(`🎉 ВСЕ ТЕСТЫ OTA И ТЕХОБСЛУЖИВАНИЯ УСПЕШНО ПРОЙДЕНЫ!`);
    console.log(`======================================================\n`);
  } finally {
    db.close();
  }
}

runMaintenanceOtaTestSuite().catch((err) => {
  console.error('\n❌ ОШИБКА ПРИ ТЕСТИРОВАНИИ:', err);
  process.exit(1);
});
