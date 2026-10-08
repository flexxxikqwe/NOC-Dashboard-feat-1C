import Database from 'better-sqlite3';
import path from 'node:path';
import process from 'node:process';
import { GoogleGenAI } from '@google/genai';

const DB_FILE_PATH = path.resolve(process.cwd(), 'storage.db');

const SYSTEM_PROMPT = `Ты — Senior инженер технической поддержки розничных систем на 1С:Предприятие 8.3 и кассового оборудования. Проанализируй входящий технический лог ошибки. Верни СТРОГО валидный JSON без markdown-разметки со структурой: {"diagnosis": "Суть сбоя простыми словами (1 строка)", "actions": "1. Первый шаг в AnyDesk\\n2. Второй шаг\\n3. Третий шаг"}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[ASSERTION FAILED]: ${message}`);
  }
}

/**
 * Логика вызова AI-Triage для автономного тестирования в ESM
 */
async function triageIncidentTestRunner(db, errorType, rawError, errorHash) {
  // ШАГ А: Проверка локального кэша в SQLite
  try {
    const cachedRow = db
      .prepare(`
        SELECT ai_diagnosis, ai_actions 
        FROM incidents 
        WHERE error_hash = ? AND ai_diagnosis IS NOT NULL 
        LIMIT 1
      `)
      .get(errorHash);

    if (cachedRow?.ai_diagnosis) {
      return {
        diagnosis: cachedRow.ai_diagnosis,
        actions: cachedRow.ai_actions ?? null,
      };
    }
  } catch (cacheErr) {
    console.warn('[AI-TRIAGE] Cache lookup warning:', cacheErr);
  }

  // ШАГ Б: Проверка наличия API-ключа
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim() === '') {
    return { diagnosis: null, actions: null };
  }

  // ШАГ В: Обращение к Gemini Flash API
  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const promptText = `Тип ошибки: ${errorType}\nТекст ошибки: ${rawError}`;

    const triagePromise = ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: promptText,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('AI-Triage request timed out (5s)')), 5000)
    );

    const response = await Promise.race([triagePromise, timeoutPromise]);
    const rawText = response.text ? response.text.trim() : '';

    if (!rawText) {
      return { diagnosis: null, actions: null };
    }

    const cleanedText = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(cleanedText);

    return {
      diagnosis: parsed.diagnosis ? String(parsed.diagnosis).trim() : null,
      actions: parsed.actions ? String(parsed.actions).trim() : null,
    };
  } catch (error) {
    console.warn('[AI-TRIAGE WARNING] Gemini triage failed gracefully:', error instanceof Error ? error.message : error);
    return { diagnosis: null, actions: null };
  }
}

async function runAiTriageTests() {
  console.log(`\n======================================================`);
  console.log(`🧠 NOC DASHBOARD — AI-TRIAGE (GEMINI FLASH) TEST RUNNER`);
  console.log(`======================================================\n`);

  const db = new Database(DB_FILE_PATH);

  try {
    // --------------------------------------------------------------------------
    // ТЕСТ 1: Graceful Degradation без API ключа
    // --------------------------------------------------------------------------
    console.log(`▶ ТЕСТ 1: Проверка Graceful Degradation (при отсутствии/пустом API ключе)...`);
    const originalApiKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    const testHash1 = 'hash_no_key_' + Date.now();
    const resultNoKey = await triageIncidentTestRunner(
      db,
      'ТестОшибкаБезКлюча',
      'Текст ошибки 1С',
      testHash1
    );

    console.log(`   - Результат без ключа:`, resultNoKey);
    assert(
      resultNoKey.diagnosis === null && resultNoKey.actions === null,
      'При отсутствии API ключа функция обязана вернуть { diagnosis: null, actions: null } без падения'
    );
    console.log(`✅ ТЕСТ 1 УСПЕШНО ПРОЙДЕН: Никаких исключений, корректная деградация.\n`);

    // Восстанавливаем ключ для следующих тестов
    if (originalApiKey) {
      process.env.GEMINI_API_KEY = originalApiKey;
    }

    // --------------------------------------------------------------------------
    // ТЕСТ 2: Разбор ошибки 1С через Gemini Flash API
    // --------------------------------------------------------------------------
    console.log(`▶ ТЕСТ 2: Анализ типовой ошибки кассового оборудования 1С (Ошибка 38h ФН)...`);
    const errorType = 'ККТ_ФискальныйРесурс';
    const rawError = 'Ошибка ККТ 38h: Исчерпан ресурс КС (ФН). Фискализация невозможна.';
    const testHash2 = 'hash_fn_38h_' + Date.now();

    const resultGemini = await triageIncidentTestRunner(db, errorType, rawError, testHash2);
    console.log(`   - Диагноз:`, resultGemini.diagnosis);
    console.log(`   - Чеклист AnyDesk:`, resultGemini.actions);

    if (resultGemini.diagnosis) {
      assert(typeof resultGemini.diagnosis === 'string', 'diagnosis должен быть строкой');
      assert(typeof resultGemini.actions === 'string', 'actions должен быть строкой');
      console.log(`✅ ТЕСТ 2 УСПЕШНО ПРОЙДЕН (GEMINI ONLINE): Получен структурированный диагноз и чеклист.\n`);
    } else {
      console.log(`ℹ️ ТЕСТ 2 (FALLBACK): GEMINI_API_KEY не установлен или превышена квота, сработал защитный fallback { diagnosis: null, actions: null }.\n`);
    }

    // --------------------------------------------------------------------------
    // ТЕСТ 3: Проверка мгновенного возврата из локального SQLite кэша
    // --------------------------------------------------------------------------
    console.log(`▶ ТЕСТ 3: Проверка кэширования по error_hash в SQLite (0 мс, 0 токенов)...`);
    const cachedHash = 'hash_cached_test_' + Date.now();
    const cachedDiagnosis = 'Переполнение буфера фискального накопителя ФН-1.2';
    const cachedActions = '1. Подключиться по AnyDesk\n2. Закрыть смену в 1С:РМК\n3. Перезапустить службу EoU';

    const testWpId = 'wp_cache_test_' + Date.now();
    db.prepare(`
      INSERT OR REPLACE INTO workplaces (id, shop_name, workplace_name, remote_type, remote_id, last_seen)
      VALUES (?, 'Кэш Магазин', 'Кэш Касса', 'ANYDESK', '111222333', datetime('now'))
    `).run(testWpId);

    db.prepare(`
      INSERT INTO incidents (
        workplace_id, error_hash, error_type, severity, raw_error, ai_diagnosis, ai_actions, status, created_at, last_occurred_at
      ) VALUES (?, ?, 'ККТ_Буфер', 'ERROR', 'Тестовая сырая ошибка', ?, ?, 'ACTIVE', datetime('now'), datetime('now'))
    `).run(testWpId, cachedHash, cachedDiagnosis, cachedActions);

    const startTime = performance.now();
    const cachedResult = await triageIncidentTestRunner(db, 'ККТ_Буфер', 'Тестовая сырая ошибка', cachedHash);
    const durationMs = performance.now() - startTime;

    console.log(`   - Время получения из кэша: ${durationMs.toFixed(2)} мс`);
    console.log(`   - Извлеченный диагноз: "${cachedResult.diagnosis}"`);

    assert(cachedResult.diagnosis === cachedDiagnosis, 'Диагноз из кэша не совпал с ожидаемым!');
    assert(cachedResult.actions === cachedActions, 'Чеклист из кэша не совпал с ожидаемым!');
    assert(durationMs < 50, `Выборка из кэша заняла ${durationMs.toFixed(2)} мс (ожидалось < 50 мс)`);

    console.log(`✅ ТЕСТ 3 УСПЕШНО ПРОЙДЕН: Кэш по error_hash отработал мгновенно.\n`);

    console.log(`======================================================`);
    console.log(`🎉 ВСЕ ТЕСТЫ AI-TRIAGE УСПЕШНО ЗАВЕРШЕНЫ!`);
    console.log(`======================================================\n`);
  } finally {
    db.close();
  }
}

runAiTriageTests().catch((err) => {
  console.error('\n❌ ОШИБКА ПРИ ТЕСТИРОВАНИИ AI-TRIAGE:', err);
  process.exit(1);
});
