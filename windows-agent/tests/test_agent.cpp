#include <iostream>
#include <cassert>
#include <string>
#include <vector>
#include <filesystem>
#include <fstream>
#include <chrono>

#include "common.hpp"
#include "json_lite.hpp"
#include "crypto_hash.hpp"
#include "sqlite_queue.hpp"
#include "spool_watcher.hpp"
#include "winhttp_transport.hpp"
#include "../vendor/sqlite/sqlite3.h"

namespace fs = std::filesystem;
using namespace noc;

static int g_tests_passed = 0;
static int g_tests_failed = 0;

#define TEST_ASSERT(cond, msg) \
    do { \
        if (!(cond)) { \
            std::cerr << "❌ FAILED: " << msg << " (line " << __LINE__ << ")\n"; \
            g_tests_failed++; \
            return; \
        } \
    } while(0)

#define RUN_TEST(fn) \
    do { \
        std::cout << "▶ Running " #fn "... "; \
        int prev_fail = g_tests_failed; \
        fn(); \
        if (g_tests_failed == prev_fail) { \
            std::cout << "PASS\n"; \
            g_tests_passed++; \
        } \
    } while(0)

// ============================================================================
// ТЕСТ 1: Строгий парсер JSON: дубликаты ключей, глубина, суррогаты, числа
// ============================================================================
void TestJsonParserHardening() {
    // 1.1 Валидный базовый JSON
    std::string valid_json = R"({
        "num": 42,
        "pi": 3.1415,
        "flag": true,
        "empty": null,
        "str": "Привет, Мир!\n\"Тест\"",
        "arr": [1, 2, "три"]
    })";

    json::Value v;
    std::string err;
    TEST_ASSERT(json::Parser::Parse(valid_json, v, err), "Valid JSON must parse successfully");
    TEST_ASSERT(v.IsObject(), "Root must be object");
    TEST_ASSERT(v["num"].AsInt64() == 42, "num must be 42");
    TEST_ASSERT(v["flag"].AsBool() == true, "flag must be true");
    TEST_ASSERT(v["empty"].IsNull(), "empty must be null");
    TEST_ASSERT(v["arr"].IsArray(), "arr must be array");
    TEST_ASSERT(v["arr"].AsArray().size() == 3, "arr size must be 3");

    // 1.2 Запрет дублирующихся ключей в объекте
    std::string dup_key_json = R"({"key": 1, "other": "val", "key": 2})";
    json::Value bad_val;
    TEST_ASSERT(!json::Parser::Parse(dup_key_json, bad_val, err), "Duplicate keys in object must be rejected");
    TEST_ASSERT(err.find("Duplicate key") != std::string::npos, "Error must mention duplicate key: " + err);

    // 1.3 Защита от переполнения стека: ограничение глубины вложенности (32)
    std::string deep_json;
    for (int i = 0; i < 40; ++i) deep_json += "{\"a\":";
    deep_json += "1";
    for (int i = 0; i < 40; ++i) deep_json += "}";
    TEST_ASSERT(!json::Parser::Parse(deep_json, bad_val, err), "Excessive nesting depth > 32 must be rejected");
    TEST_ASSERT(err.find("nesting depth") != std::string::npos, "Error must mention nesting depth: " + err);

    // 1.4 Запрет UTF-8 BOM (0xEF, 0xBB, 0xBF)
    std::string bom_json = "\xEF\xBB\xBF{\"key\":\"value\"}";
    TEST_ASSERT(!json::Parser::Parse(bom_json, bad_val, err), "JSON with BOM must be rejected");
    TEST_ASSERT(err.find("BOM") != std::string::npos, "Error must mention BOM");

    // 1.5 Запрет некорректного UTF-8
    std::string bad_utf8 = "{\"text\":\"\xFF\xFE bad\"}";
    TEST_ASSERT(!json::Parser::Parse(bad_utf8, bad_val, err), "Invalid UTF-8 must be rejected");

    // 1.6 Запрет завершающих запятых (Trailing comma)
    std::string trailing_comma = "{\"a\": 1, }";
    TEST_ASSERT(!json::Parser::Parse(trailing_comma, bad_val, err), "Trailing comma in object must be rejected");

    std::string trailing_arr = "[1, 2, ]";
    TEST_ASSERT(!json::Parser::Parse(trailing_arr, bad_val, err), "Trailing comma in array must be rejected");

    // 1.7 Запрет ведущих нулей в числах
    std::string leading_zero = "{\"val\": 0123}";
    TEST_ASSERT(!json::Parser::Parse(leading_zero, bad_val, err), "Leading zero numbers must be rejected");

    // 1.8 Строгая проверка UTF-16 суррогатов в \u экранировании
    // Одиночный high surrogate без low: \uD800\u0020
    std::string unpaired_high = "{\"emoji\": \"\\uD800 test\"}";
    TEST_ASSERT(!json::Parser::Parse(unpaired_high, bad_val, err), "Unpaired UTF-16 high surrogate must be rejected");

    // Изолированный low surrogate: \uDC00
    std::string isolated_low = "{\"emoji\": \"\\uDC00\"}";
    TEST_ASSERT(!json::Parser::Parse(isolated_low, bad_val, err), "Isolated UTF-16 low surrogate must be rejected");

    // Корректная суррогатная пара: U+1F600 (\uD83D\uDE00) -> 😀
    std::string valid_pair = "{\"emoji\": \"\\uD83D\\uDE00\"}";
    json::Value emoji_val;
    TEST_ASSERT(json::Parser::Parse(valid_pair, emoji_val, err), "Valid surrogate pair must parse: " + err);
    TEST_ASSERT(emoji_val["emoji"].AsString() == "\xF0\x9F\x98\x80", "Surrogate pair must decode to UTF-8 F0 9F 98 80");

    // 1.9 Мусор после закрывающей скобки
    std::string trailing_garbage = "{\"a\": 1} extra garbage";
    TEST_ASSERT(!json::Parser::Parse(trailing_garbage, bad_val, err), "Trailing characters after JSON must be rejected");

    // 1.10 Нетерминированная строка
    std::string unterminated = "{\"str\": \"unfinished";
    TEST_ASSERT(!json::Parser::Parse(unterminated, bad_val, err), "Unterminated string must be rejected");

    // 1.11 Недопустимые escape-последовательности
    std::string bad_esc1 = "{\"str\": \"bad \\q escape\"}";
    TEST_ASSERT(!json::Parser::Parse(bad_esc1, bad_val, err), "Invalid escape \\q must be rejected");

    std::string bad_esc2 = "{\"str\": \"bad \\x41 escape\"}";
    TEST_ASSERT(!json::Parser::Parse(bad_esc2, bad_val, err), "Non-JSON escape \\x must be rejected");

    // 1.12 Некорректные форматы чисел
    std::string bad_num1 = "{\"n\": 1.}";
    TEST_ASSERT(!json::Parser::Parse(bad_num1, bad_val, err), "Trailing dot in number must be rejected");

    std::string bad_num2 = "{\"n\": 1e}";
    TEST_ASSERT(!json::Parser::Parse(bad_num2, bad_val, err), "Exponent without digits must be rejected");

    std::string bad_num3 = "{\"n\": 1.2.3}";
    TEST_ASSERT(!json::Parser::Parse(bad_num3, bad_val, err), "Multiple decimal points must be rejected");

    std::string bad_num4 = "{\"n\": --5}";
    TEST_ASSERT(!json::Parser::Parse(bad_num4, bad_val, err), "Multiple signs in number must be rejected");

    // 1.13 Пустой ввод
    std::string empty_input = "";
    TEST_ASSERT(!json::Parser::Parse(empty_input, bad_val, err), "Empty JSON input must be rejected");
}

// ============================================================================
// ТЕСТ 2: Валидатор Spool Envelope v1.0
// ============================================================================
void TestSpoolEnvelopeValidation() {
    // 2.1 Эталонный пакет из SPOOL_CONTRACT.md
    std::string valid_envelope_json = R"({
      "schema_version": "1.0",
      "event_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      "timestamp_utc": "2026-10-12T14:30:00.123Z",
      "source": "1C_EXTENSION",
      "event_type": "TELEMETRY",
      "priority": "NORMAL",
      "payload": {
        "shop": "Магазин Розница №42",
        "workplace": "Касса 1",
        "warnings": [
          "Кассовая смена открыта более 24 часов"
        ],
        "runtime_errors": [
          {
            "time": "2026-10-12T14:28:15Z",
            "event": "1C_Runtime_Error",
            "error_text": "Ошибка при вызове метода контекста (ПечатьЧека): ККТ не отвечает."
          }
        ],
        "health_checks": [
          {
            "id": "shift_duration_24h",
            "name": "Длительность кассовой смены",
            "status": "WARN",
            "details": "Кассовая смена открыта более 24 часов."
          }
        ],
        "one_c_info": {
          "platform_version": "8.3.24.1540",
          "configuration_name": "Розница, редакция 2.3",
          "computer_name": "POS-TERM-01"
        }
      }
    })";

    SpoolEnvelope env;
    std::string err;
    TEST_ASSERT(json::Parser::ParseSpoolEnvelope(valid_envelope_json, env, err), 
                "Valid envelope must pass validation: " + err);
    TEST_ASSERT(env.schema_version == "1.0", "schema_version must be 1.0");
    TEST_ASSERT(env.event_id == "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d", "event_id must match");
    TEST_ASSERT(env.shop == "Магазин Розница №42", "shop must match");
    TEST_ASSERT(env.workplace == "Касса 1", "workplace must match");
    TEST_ASSERT(env.priority == "NORMAL", "priority must be NORMAL");
    TEST_ASSERT(env.warnings.size() == 1, "warnings count must be 1");
    TEST_ASSERT(env.one_c_info.platform_version == "8.3.24.1540", "platform_version must match");

    // 2.2 Неверная версия схемы
    std::string bad_ver = valid_envelope_json;
    bad_ver.replace(bad_ver.find("\"1.0\""), 5, "\"2.0\"");
    TEST_ASSERT(!json::Parser::ParseSpoolEnvelope(bad_ver, env, err), "schema_version 2.0 must be rejected");

    // 2.3 Неверный источник source
    std::string bad_src = valid_envelope_json;
    bad_src.replace(bad_src.find("\"1C_EXTENSION\""), 14, "\"EXTERNAL_HTTP\"");
    TEST_ASSERT(!json::Parser::ParseSpoolEnvelope(bad_src, env, err), "source != 1C_EXTENSION must be rejected");

    // 2.4 Неверный формат event_id (не GUID / не-hex символы)
    std::string bad_guid = valid_envelope_json;
    bad_guid.replace(bad_guid.find("a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d"), 36, "invalid-guid-12345678901234567890123");
    TEST_ASSERT(!json::Parser::ParseSpoolEnvelope(bad_guid, env, err), "Invalid GUID must be rejected");

    // 2.5 Неверный таймстемп (без Z)
    std::string bad_ts = valid_envelope_json;
    bad_ts.replace(bad_ts.find(".123Z"), 5, ".123+03:00");
    TEST_ASSERT(!json::Parser::ParseSpoolEnvelope(bad_ts, env, err), "Timestamp without trailing 'Z' must be rejected");

    // 2.6 Неверный приоритет
    std::string bad_prio = valid_envelope_json;
    bad_prio.replace(bad_prio.find("\"NORMAL\""), 8, "\"CRITICAL\"");
    TEST_ASSERT(!json::Parser::ParseSpoolEnvelope(bad_prio, env, err), "Priority CRITICAL must be rejected");

    // 2.7 Отсутствие обязательного поля payload.shop
    std::string missing_shop = R"({
      "schema_version": "1.0",
      "event_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      "timestamp_utc": "2026-10-12T14:30:00.123Z",
      "source": "1C_EXTENSION",
      "event_type": "TELEMETRY",
      "priority": "NORMAL",
      "payload": {
        "workplace": "Касса 1"
      }
    })";
    TEST_ASSERT(!json::Parser::ParseSpoolEnvelope(missing_shop, env, err), "Missing shop must be rejected");

    // 2.8 Несоответствие типов: payload.warnings как строка вместо массива
    std::string bad_type_warnings = R"({
      "schema_version": "1.0",
      "event_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      "timestamp_utc": "2026-10-12T14:30:00.123Z",
      "source": "1C_EXTENSION",
      "event_type": "TELEMETRY",
      "priority": "NORMAL",
      "payload": {
        "shop": "S",
        "workplace": "W",
        "warnings": "single string instead of array"
      }
    })";
    TEST_ASSERT(!json::Parser::ParseSpoolEnvelope(bad_type_warnings, env, err), "String warnings instead of array must be rejected");

    // 2.9 Пакет более 64 КБ (65 536 байт)
    std::string huge_padding(70000, 'A');
    std::string oversized = "{\"schema_version\":\"1.0\",\"event_id\":\"a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d\",\"timestamp_utc\":\"2026-10-12T14:30:00Z\",\"source\":\"1C_EXTENSION\",\"event_type\":\"TELEMETRY\",\"priority\":\"NORMAL\",\"payload\":{\"shop\":\"S\",\"workplace\":\"W\",\"pad\":\"" + huge_padding + "\"}}";
    TEST_ASSERT(!json::Parser::ParseSpoolEnvelope(oversized, env, err), "Oversized >64KB envelope must be rejected");
}

// ============================================================================
// ТЕСТ 3: SHA-256 хеширование (NIST test vectors и пустой ввод)
// ============================================================================
void TestCryptoSha256() {
    // 3.1 Тестовый вектор NIST для "abc"
    // ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    std::string h1 = crypto::ComputeSha256("abc");
    TEST_ASSERT(h1 == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", 
                "SHA-256 for 'abc' must match NIST standard: " + h1);

    // 3.2 Пустая строка: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    std::string h_empty = crypto::ComputeSha256("");
    TEST_ASSERT(h_empty == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", 
                "SHA-256 for empty string must match NIST standard: " + h_empty);

    // 3.3 NIST вектор: "The quick brown fox jumps over the lazy dog"
    // d7a8fbb307d7809469ca9ab400f20f5f99feed17ea2a2dce88a371e63ab1dc1f
    std::string fox = "The quick brown fox jumps over the lazy dog";
    std::string h_fox = crypto::ComputeSha256(fox);
    TEST_ASSERT(h_fox == "d7a8fbb307d7809469ca9ab400f20f5f99feed17ea2a2dce88a371e63ab1dc1f",
                "SHA-256 for 'quick brown fox' must match NIST standard: " + h_fox);

    // 3.4 NIST вектор: "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
    // 248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1
    std::string nist_448 = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    std::string h_nist_448 = crypto::ComputeSha256(nist_448);
    TEST_ASSERT(h_nist_448 == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
                "SHA-256 for 448-bit NIST string must match");

    // 3.5 Большой буфер (100 КБ)
    std::string large_buf(102400, 'Z');
    std::string h_large = crypto::ComputeSha256(large_buf);
    TEST_ASSERT(h_large.size() == 64, "SHA-256 of large buffer must be 64 hex characters");
}

// ============================================================================
// ТЕСТ 4: SQLite долговечность (WAL + synchronous=FULL), дедупликация и коллизии
// ============================================================================
void TestSqliteDurabilityAndCollisions() {
    std::string test_db = "/tmp/test_noc_durability_queue.db";
    std::error_code ec;
    fs::remove(test_db, ec);
    fs::remove(test_db + "-wal", ec);
    fs::remove(test_db + "-shm", ec);

    db::SqliteQueue queue;
    std::string err;
    TEST_ASSERT(queue.Open(test_db, err), "SQLite DB must open successfully: " + err);

    // 4.1 Проверка целостности и режимов PRAGMA
    TEST_ASSERT(queue.CheckIntegrity(err), "Integrity check must return ok");

    // 4.2 Вставка первой записи
    SpoolEnvelope env1;
    env1.event_id = "11111111-1111-1111-1111-111111111111";
    env1.timestamp_utc = "2026-10-12T10:00:00Z";
    env1.event_type = "TELEMETRY";
    env1.priority = "NORMAL";
    env1.raw_json = "{\"test\":1}";
    env1.sha256_hash = crypto::ComputeSha256(env1.raw_json);

    auto res1 = queue.Enqueue(env1);
    TEST_ASSERT(res1.status == db::EnqueueStatus::SUCCESS_INSERTED, "First record must be inserted");
    TEST_ASSERT(res1.record_id > 0, "Record ID must be positive");

    // 4.3 Идемпотентный повтор идентичного SHA-256 и идентичного содержимого
    auto res1_dup = queue.Enqueue(env1);
    TEST_ASSERT(res1_dup.status == db::EnqueueStatus::DUPLICATE_IGNORED, "Duplicate SHA-256 must be ignored");
    TEST_ASSERT(res1_dup.record_id == res1.record_id, "Duplicate must reference existing record ID");

    // 4.4 Проверка защиты от ложной дедупликации: совпадение SHA-256 при различном теле payload
    SpoolEnvelope env1_tampered = env1;
    env1_tampered.raw_json = "{\"test\": \"MODIFIED_DIFFERENT_PAYLOAD\"}"; // Подделка!
    auto res1_tampered = queue.Enqueue(env1_tampered);
    TEST_ASSERT(res1_tampered.status == db::EnqueueStatus::COLLISION_DETECTED,
                "Digest match with differing content must trigger COLLISION_DETECTED");

    // 4.5 Обнаружение коллизии event_id (одинаковый GUID, но разный payload/SHA-256)
    SpoolEnvelope env_collision;
    env_collision.event_id = "11111111-1111-1111-1111-111111111111"; // тот же event_id!
    env_collision.timestamp_utc = "2026-10-12T10:00:05Z";
    env_collision.event_type = "TELEMETRY";
    env_collision.priority = "NORMAL";
    env_collision.raw_json = "{\"test\": \"MODIFIED_PAYLOAD\"}"; // другое содержимое!
    env_collision.sha256_hash = crypto::ComputeSha256(env_collision.raw_json);

    auto res_coll = queue.Enqueue(env_collision);
    TEST_ASSERT(res_coll.status == db::EnqueueStatus::COLLISION_DETECTED, 
                "Colliding event_id with different payload must trigger COLLISION_DETECTED");

    // 4.6 Приоритеты FIFO выборки (HIGH перед NORMAL перед LOW)
    SpoolEnvelope env_high;
    env_high.event_id = "22222222-2222-2222-2222-222222222222";
    env_high.timestamp_utc = "2026-10-12T10:01:00Z";
    env_high.event_type = "INCIDENT";
    env_high.priority = "HIGH";
    env_high.raw_json = "{\"incident\": true}";
    env_high.sha256_hash = crypto::ComputeSha256(env_high.raw_json);

    auto res_high = queue.Enqueue(env_high);
    TEST_ASSERT(res_high.status == db::EnqueueStatus::SUCCESS_INSERTED, "High priority incident must be inserted");

    std::vector<QueueRecord> pending;
    TEST_ASSERT(queue.GetPending(10, pending, err), "GetPending must succeed");
    TEST_ASSERT(pending.size() == 2, "Pending count must be 2");
    // Первая запись должна быть HIGH приоритета
    TEST_ASSERT(pending[0].priority == "HIGH", "First record fetched must have HIGH priority");
    TEST_ASSERT(pending[1].priority == "NORMAL", "Second record fetched must have NORMAL priority");

    // 4.7 Проверка учета размера WAL и выполнение checkpoint
    TEST_ASSERT(queue.Checkpoint(err), "Passive WAL checkpoint must succeed: " + err);

    size_t count = 0;
    int64_t bytes = 0;
    TEST_ASSERT(queue.GetStats(count, bytes, err), "GetStats must succeed");
    TEST_ASSERT(count == 2, "Queue count must be 2");
    TEST_ASSERT(bytes > 0, "Database size must be positive");

    // 4.8 Тест долговечности при перезапуске (Crash & Restart recovery)
    queue.Close();
    db::SqliteQueue queue_reopened;
    TEST_ASSERT(queue_reopened.Open(test_db, err), "Reopening DB after close must succeed: " + err);
    TEST_ASSERT(queue_reopened.CheckIntegrity(err), "Reopened DB integrity must be OK");
    std::vector<QueueRecord> recovered_records;
    TEST_ASSERT(queue_reopened.GetPending(10, recovered_records, err), "GetPending on recovered DB must succeed");
    TEST_ASSERT(recovered_records.size() == 2, "All 2 durably committed records must survive reopen");
    TEST_ASSERT(recovered_records[0].event_id == env_high.event_id, "Recovered HIGH priority event_id matches");
    TEST_ASSERT(recovered_records[1].event_id == env1.event_id, "Recovered NORMAL priority event_id matches");
    queue_reopened.Close();

    fs::remove(test_db, ec);
    fs::remove(test_db + "-wal", ec);
    fs::remove(test_db + "-shm", ec);
}

// ============================================================================
// ТЕСТ 5: SpoolWatcher, Карантин коллизий и Crash Recovery
// ============================================================================
void TestSpoolWatcherAndQuarantine() {
    std::string test_spool = "/tmp/test_noc_spool_h";
    std::string test_quar = "/tmp/test_noc_quarantine_h";
    std::string test_db = "/tmp/test_noc_spool_db_h.db";

    std::error_code ec;
    fs::remove_all(test_spool, ec);
    fs::remove_all(test_quar, ec);
    fs::remove(test_db, ec);
    fs::remove(test_db + "-wal", ec);
    fs::remove(test_db + "-shm", ec);

    db::SqliteQueue queue;
    std::string err;
    TEST_ASSERT(queue.Open(test_db, err), "DB must open");

    spool::SpoolWatcher watcher(test_spool, test_quar, queue);
    TEST_ASSERT(watcher.Initialize(err), "Watcher must initialize");

    // 5.1 Удаление зависших temp_*.tmp файлов старше 300 секунд (Crash Recovery)
    std::string stale_tmp = test_spool + "/temp_stale_12345.tmp";
    {
        std::ofstream ofs(stale_tmp);
        ofs << "in-flight data";
    }

    auto old_time = fs::file_time_type::clock::now() - std::chrono::seconds(600);
    fs::last_write_time(stale_tmp, old_time);

    size_t swept = watcher.SweepStaleTmpFiles(300);
    TEST_ASSERT(swept == 1, "Must sweep 1 stale temp file");
    TEST_ASSERT(!fs::exists(stale_tmp), "Stale temp file must be deleted");

    // 5.2 Валидный пакет: сохранение в SQLite и удаление из spool
    std::string valid_file = test_spool + "/20261012143000123_a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d.json";
    {
        std::ofstream ofs(valid_file);
        ofs << R"json({
          "schema_version": "1.0",
          "event_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
          "timestamp_utc": "2026-10-12T14:30:00.123Z",
          "source": "1C_EXTENSION",
          "event_type": "TELEMETRY",
          "priority": "NORMAL",
          "payload": {
            "shop": "Магазин Розница",
            "workplace": "Касса 1"
          }
        })json";
    }

    size_t processed = watcher.ProcessOnce(err);
    TEST_ASSERT(processed == 1, "Processed count must be 1");
    TEST_ASSERT(!fs::exists(valid_file), "Spool file must be unlinked after durable commit");

    // 5.3 Коллизия event_id: изоляция файла в Карантин с тегом COLLISION_EVENT_ID
    std::string colliding_file = test_spool + "/20261012143000555_a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d.json";
    {
        std::ofstream ofs(colliding_file);
        ofs << R"json({
          "schema_version": "1.0",
          "event_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
          "timestamp_utc": "2026-10-12T14:30:00.555Z",
          "source": "1C_EXTENSION",
          "event_type": "TELEMETRY",
          "priority": "NORMAL",
          "payload": {
            "shop": "Магазин Розница [КОЛЛИЗИЯ]",
            "workplace": "Касса 1"
          }
        })json";
    }

    watcher.ProcessOnce(err);
    TEST_ASSERT(!fs::exists(colliding_file), "Colliding file must be removed from spool");

    bool found_collision_quar = false;
    for (const auto& entry : fs::directory_iterator(test_quar)) {
        if (entry.path().filename().string().find("COLLISION_EVENT_ID") != std::string::npos) {
            found_collision_quar = true;
            break;
        }
    }
    TEST_ASSERT(found_collision_quar, "Colliding event must be isolated in quarantine with COLLISION_EVENT_ID");

    // 5.4 Повреждённый JSON -> изоляция с тегом INVALID_ENVELOPE
    std::string corrupt_file = test_spool + "/20261012143000999_b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e.json";
    {
        std::ofstream ofs(corrupt_file);
        ofs << "{ corrupt json: missing brackets";
    }

    watcher.ProcessOnce(err);
    TEST_ASSERT(!fs::exists(corrupt_file), "Corrupt file must be removed from spool");

    bool found_corrupt_quar = false;
    for (const auto& entry : fs::directory_iterator(test_quar)) {
        if (entry.path().filename().string().find("INVALID_ENVELOPE") != std::string::npos) {
            found_corrupt_quar = true;
            break;
        }
    }
    TEST_ASSERT(found_corrupt_quar, "Corrupt file must be moved to quarantine with INVALID_ENVELOPE");

    // 5.5 Файл превышающий лимит 64 КБ (> 65536 байт) -> изоляция с тегом OVERSIZED_64KB
    std::string oversized_file = test_spool + "/20261012143000998_c3d4e5f6-a7b8-9c0d-1e2f-3a4b5c6d7e8f.json";
    {
        std::ofstream ofs(oversized_file);
        std::string huge(70000, 'X');
        ofs << "{\"huge\":\"" << huge << "\"}";
    }

    watcher.ProcessOnce(err);
    TEST_ASSERT(!fs::exists(oversized_file), "Oversized file must be removed from spool");

    bool found_oversized_quar = false;
    for (const auto& entry : fs::directory_iterator(test_quar)) {
        if (entry.path().filename().string().find("OVERSIZED_64KB") != std::string::npos) {
            found_oversized_quar = true;
            break;
        }
    }
    TEST_ASSERT(found_oversized_quar, "Oversized file must be moved to quarantine with OVERSIZED_64KB");

    // 5.6 Файл нулевого размера (in-flight запись 1С) -> пропускается без удаления и без карантина
    std::string empty_file = test_spool + "/20261012143000997_d4e5f6a7-b89c-0d1e-2f3a-4b5c6d7e8f90.json";
    {
        std::ofstream ofs(empty_file);
    }
    TEST_ASSERT(fs::exists(empty_file) && fs::file_size(empty_file) == 0, "Empty file created");

    watcher.ProcessOnce(err);
    TEST_ASSERT(fs::exists(empty_file), "In-flight zero-byte file must remain in spool without deletion");
    fs::remove(empty_file, ec);

    // 5.7 Повторное чтение идентичного события -> удаление дубликата из spool без ошибки
    std::string dup_file = test_spool + "/20261012143000124_a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d.json";
    {
        std::ofstream ofs(dup_file);
        ofs << R"json({
          "schema_version": "1.0",
          "event_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
          "timestamp_utc": "2026-10-12T14:30:00.123Z",
          "source": "1C_EXTENSION",
          "event_type": "TELEMETRY",
          "priority": "NORMAL",
          "payload": {
            "shop": "Магазин Розница",
            "workplace": "Касса 1"
          }
        })json";
    }

    size_t dup_processed = watcher.ProcessOnce(err);
    TEST_ASSERT(dup_processed == 1, "Duplicate processed successfully");
    TEST_ASSERT(!fs::exists(dup_file), "Duplicate file must be cleaned from spool");

    queue.Close();
    fs::remove_all(test_spool, ec);
    fs::remove_all(test_quar, ec);
    fs::remove(test_db, ec);
    fs::remove(test_db + "-wal", ec);
    fs::remove(test_db + "-shm", ec);
}

// ============================================================================
// ТЕСТ 6: WinHTTP Транспорт (бизнес-логика, MockHttpClient, бэкофф, безопасность)
// ============================================================================
void TestWinHttpTransportLogic() {
    // 6.1 Маскирование токена в логах (Zero Token Leakage)
    std::string secret = "dev-secret-token-2026";
    std::string masked = transport::MaskTokenForLog(secret);
    TEST_ASSERT(masked.find("dev") != std::string::npos, "Masked token starts with prefix");
    TEST_ASSERT(masked.find("secret") == std::string::npos, "Masked token NEVER contains secret middle part");
    TEST_ASSERT(masked == "dev...26 (21 chars)", "Masked token format matches specification: " + masked);
    TEST_ASSERT(transport::MaskTokenForLog("") == "(empty)", "Empty token handled safely");
    TEST_ASSERT(transport::MaskTokenForLog("short") == "***", "Short token masked with asterisks");

    // 6.2 Парсинг HTTP/HTTPS URL
    bool is_https = false;
    std::string host, path, url_err;
    uint16_t port = 0;

    TEST_ASSERT(transport::ParseHttpUrl("https://noc.company.local:3000/api/v1/telemetry", is_https, host, port, path, url_err), "HTTPS URL parse ok");
    TEST_ASSERT(is_https == true, "Scheme must be https");
    TEST_ASSERT(host == "noc.company.local", "Host must match");
    TEST_ASSERT(port == 3000, "Port must be 3000");
    TEST_ASSERT(path == "/api/v1/telemetry", "Path must match");

    TEST_ASSERT(transport::ParseHttpUrl("https://noc.company.local", is_https, host, port, path, url_err), "Default port parse ok");
    TEST_ASSERT(port == 443, "Default HTTPS port must be 443");
    TEST_ASSERT(path == "/", "Default path must be /");

    TEST_ASSERT(!transport::ParseHttpUrl("ftp://invalid.scheme", is_https, host, port, path, url_err), "Invalid scheme must be rejected");

    // 6.3 Расчет экспоненциального бэкоффа
    TEST_ASSERT(transport::TransportManager::CalculateBackoffSeconds(0) == 5, "Retry 0 backoff = 5s");
    TEST_ASSERT(transport::TransportManager::CalculateBackoffSeconds(1) == 10, "Retry 1 backoff = 10s");
    TEST_ASSERT(transport::TransportManager::CalculateBackoffSeconds(2) == 20, "Retry 2 backoff = 20s");
    TEST_ASSERT(transport::TransportManager::CalculateBackoffSeconds(3) == 40, "Retry 3 backoff = 40s");
    TEST_ASSERT(transport::TransportManager::CalculateBackoffSeconds(4) == 80, "Retry 4 backoff = 80s");
    TEST_ASSERT(transport::TransportManager::CalculateBackoffSeconds(5) == 160, "Retry 5 backoff = 160s");
    TEST_ASSERT(transport::TransportManager::CalculateBackoffSeconds(6) == 300, "Retry 6 backoff clamped to 300s");
    TEST_ASSERT(transport::TransportManager::CalculateBackoffSeconds(10) == 300, "Retry 10 backoff ceiling = 300s");
    TEST_ASSERT(transport::TransportManager::CalculateBackoffSeconds(0, 45) == 45, "Retry-After header 45s takes precedence");

    // 6.4 Трансформация SpoolEnvelope в Ingestion Payload
    SpoolEnvelope env;
    env.shop = "Магазин Розница 1";
    env.workplace = "Касса 2";
    env.warnings = {"Внимание: смена > 24ч"};
    env.runtime_errors_raw_json = "[{\"time\":\"2026-10-12T14:00:00Z\",\"event\":\"1C_Err\",\"error_text\":\"ККТ timeout\"}]";
    env.health_checks_raw_json = "[{\"id\":\"ofd_queue\",\"status\":\"WARN\",\"details\":\"Буфер ОФД 15 чеков\"}]";
    env.one_c_info.platform_version = "8.3.24.1540";
    env.one_c_info.configuration_name = "Розница 2.3";
    env.one_c_info.computer_name = "POS-01";
    env.event_id = "test-guid-1234";
    env.event_type = "INCIDENT";
    env.priority = "HIGH";
    env.timestamp_utc = "2026-10-12T14:30:00Z";

    std::string ingest_json = transport::EnvelopeToIngestionPayload(env, "NONE", "");
    json::Value parsed_ingest;
    std::string perr;
    TEST_ASSERT(json::Parser::Parse(ingest_json, parsed_ingest, perr), "Ingest payload must be valid JSON: " + perr);
    TEST_ASSERT(parsed_ingest.IsObject(), "Root must be object");
    TEST_ASSERT(parsed_ingest["shop"].AsString() == "Магазин Розница 1", "shop field matches");
    TEST_ASSERT(parsed_ingest["workplace"].AsString() == "Касса 2", "workplace field matches");
    TEST_ASSERT(parsed_ingest["remote"]["type"].AsString() == "NONE", "remote.type matches");
    TEST_ASSERT(parsed_ingest["warnings"].AsArray().size() == 1, "warnings size matches");
    TEST_ASSERT(parsed_ingest["runtime_errors"].AsArray().size() == 1, "runtime_errors size matches");
    TEST_ASSERT(parsed_ingest["health_checks"].AsArray().size() == 1, "health_checks size matches");
    TEST_ASSERT(parsed_ingest["system_info"]["one_c"]["platform_version"].AsString() == "8.3.24.1540", "one_c matches");

    // 6.5 Сквозной цикл отправки через MockHttpClient и SqliteQueue
    std::string test_db = "/tmp/test_noc_transport_queue.db";
    std::error_code ec;
    fs::remove(test_db, ec);
    fs::remove(test_db + "-wal", ec);
    fs::remove(test_db + "-shm", ec);

    db::SqliteQueue queue;
    std::string q_err;
    TEST_ASSERT(queue.Open(test_db, q_err), "DB opens for transport tests");

    // Добавляем тестовое событие в очередь
    env.raw_json = R"json({
      "schema_version": "1.0",
      "event_id": "33333333-3333-3333-3333-333333333333",
      "timestamp_utc": "2026-10-12T15:00:00Z",
      "source": "1C_EXTENSION",
      "event_type": "TELEMETRY",
      "priority": "HIGH",
      "payload": {
        "shop": "Магазин Розница 1",
        "workplace": "Касса 2"
      }
    })json";
    env.sha256_hash = crypto::ComputeSha256(env.raw_json);
    env.event_id = "33333333-3333-3333-3333-333333333333";

    auto enq_res = queue.Enqueue(env);
    TEST_ASSERT(enq_res.status == db::EnqueueStatus::SUCCESS_INSERTED, "Test event enqueued");

    // Создаем MockHttpClient
    auto mock_client = std::make_shared<transport::MockHttpClient>();
    transport::TransportManager manager(queue, mock_client);

    transport::TransportConfig cfg;
    cfg.server_url = "https://noc.company.local:3000";
    cfg.token = "dev-secret-token-2026";
    cfg.enabled = false; // По умолчанию выключен!
    manager.SetConfig(cfg);

    // Проверка 6.5.1: Выключенный по умолчанию транспорт не делает запросов
    std::string batch_err;
    size_t sent = manager.ProcessPendingBatch(batch_err);
    TEST_ASSERT(sent == 0, "Disabled transport sends 0 events");
    TEST_ASSERT(mock_client->GetCallCount() == 0, "Disabled transport makes 0 network calls");

    // Проверка 6.5.2: Запрет plain HTTP (HTTPS required)
    cfg.enabled = true;
    cfg.server_url = "http://unencrypted.server.com"; // HTTP без разрешения
    cfg.allow_insecure_http = false;
    manager.SetConfig(cfg);
    sent = manager.ProcessPendingBatch(batch_err);
    TEST_ASSERT(sent == 0, "Insecure HTTP must be rejected");
    TEST_ASSERT(mock_client->GetCallCount() == 0, "Insecure HTTP makes 0 network calls");
    TEST_ASSERT(batch_err.find("HTTPS required") != std::string::npos, "Error mentions HTTPS required");

    // Проверка 6.5.3: Успешная доставка по HTTPS (HTTP 200, success: true)
    cfg.server_url = "https://noc.company.local:3000";
    manager.SetConfig(cfg);

    mock_client->SetHandler([](const std::string& url, const std::string& token, const std::string& payload) {
        TEST_ASSERT(url == "https://noc.company.local:3000/api/v1/telemetry", "Target URL matches Ingestion API");
        TEST_ASSERT(token == "dev-secret-token-2026", "Bearer token passed to client");
        TEST_ASSERT(payload.find("Магазин Розница 1") != std::string::npos, "Payload contains shop name");
        transport::HttpResponse resp;
        resp.status_code = 200;
        resp.body = "{\"success\":true,\"workplace_id\":\"wp_123\",\"incidents_recorded\":1}";
        return resp;
    });

    sent = manager.ProcessPendingBatch(batch_err);
    TEST_ASSERT(sent == 1, "Successfully sent 1 event");
    TEST_ASSERT(mock_client->GetCallCount() == 1, "Mock client called once");

    // Проверяем, что статус записи в БД обновился на 'SENT'
    std::vector<QueueRecord> pending;
    queue.GetPending(10, pending, q_err);
    TEST_ASSERT(pending.empty(), "Pending queue is now empty (record marked as SENT)");

    // Проверка 6.5.4: Обработка HTTP 401 (Auth Failure) -> статус остается PENDING, токен не логируется
    // Добавляем второе событие
    env.event_id = "44444444-4444-4444-4444-444444444444";
    env.raw_json = "{\"schema_version\":\"1.0\",\"event_id\":\"44444444-4444-4444-4444-444444444444\",\"timestamp_utc\":\"2026-10-12T15:05:00Z\",\"source\":\"1C_EXTENSION\",\"event_type\":\"TELEMETRY\",\"priority\":\"NORMAL\",\"payload\":{\"shop\":\"S\",\"workplace\":\"W\"}}";
    env.sha256_hash = crypto::ComputeSha256(env.raw_json);
    queue.Enqueue(env);

    mock_client->SetHandler([](const std::string&, const std::string&, const std::string&) {
        transport::HttpResponse r;
        r.status_code = 401;
        r.body = "{\"error\":\"Unauthorized. Invalid or missing Bearer token.\"}";
        return r;
    });

    sent = manager.ProcessPendingBatch(batch_err);
    TEST_ASSERT(sent == 0, "No events sent on 401");
    TEST_ASSERT(manager.IsInBackoff(), "Backoff activated after 401 auth error");
    queue.GetPending(10, pending, q_err);
    TEST_ASSERT(pending.size() == 1, "Record remains in queue (PENDING) after 401");
    TEST_ASSERT(pending[0].retry_count == 1, "Retry count incremented after 401");

    // Проверка 6.5.5: Обработка HTTP 429 (Rate Limit с Retry-After: 45)
    // Сбрасываем бэкофф вручную для теста
    cfg.poll_interval_ms = 100;
    manager.SetConfig(cfg);

    mock_client->SetHandler([](const std::string&, const std::string&, const std::string&) {
        transport::HttpResponse r;
        r.status_code = 429;
        r.retry_after_seconds = 45;
        r.body = "{\"error\":\"Too Many Requests\"}";
        return r;
    });

    // Принудительно вызываем сброс времени бэкоффа для теста
    // Создаем новый менеджер с тем же клиентом для сброса таймера
    transport::TransportManager manager_retry(queue, mock_client);
    manager_retry.SetConfig(cfg);
    sent = manager_retry.ProcessPendingBatch(batch_err);
    TEST_ASSERT(sent == 0, "No events sent on 429");
    TEST_ASSERT(manager_retry.IsInBackoff(), "Backoff activated on 429");
    TEST_ASSERT(manager_retry.GetRemainingBackoffSeconds() >= 40, "Retry-After 45s respected");

    // Проверка 6.5.6: Сетевой сбой (Network Error / Timeout) -> сохранение в очереди
    mock_client->SetHandler([](const std::string&, const std::string&, const std::string&) {
        transport::HttpResponse r;
        r.status_code = 0;
        r.network_error = true;
        r.error_message = "Connection reset by peer / timeout";
        return r;
    });

    transport::TransportManager manager_net(queue, mock_client);
    manager_net.SetConfig(cfg);
    sent = manager_net.ProcessPendingBatch(batch_err);
    TEST_ASSERT(sent == 0, "No events sent on network error");
    queue.GetPending(10, pending, q_err);
    TEST_ASSERT(pending.size() == 1, "Record strictly preserved in queue on network error");

    // Проверка 6.5.7: Остановка службы во время ожидания (Graceful Stop)
    manager_net.Start();
    TEST_ASSERT(manager_net.IsRunning(), "Transport manager running");
    manager_net.Stop();
    TEST_ASSERT(!manager_net.IsRunning(), "Transport manager stopped cleanly without deadlock");

    queue.Close();
    fs::remove(test_db, ec);
    fs::remove(test_db + "-wal", ec);
    fs::remove(test_db + "-shm", ec);
}

int main() {
    std::cout << "================================================================\n";
    std::cout << "⚡ 1C-NOC WINDOWS AGENT — UNIT TESTS (PHASE 4.2.1 & 4.3 TRANSPORT)\n";
    std::cout << "================================================================\n\n";

    RUN_TEST(TestJsonParserHardening);
    RUN_TEST(TestSpoolEnvelopeValidation);
    RUN_TEST(TestCryptoSha256);
    RUN_TEST(TestSqliteDurabilityAndCollisions);
    RUN_TEST(TestSpoolWatcherAndQuarantine);
    RUN_TEST(TestWinHttpTransportLogic);

    std::cout << "\n================================================================\n";
    std::cout << "RESULTS: " << g_tests_passed << " PASSED, " << g_tests_failed << " FAILED\n";
    std::cout << "================================================================\n";

    return (g_tests_failed == 0) ? 0 : 1;
}
