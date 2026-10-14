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
        ofs << R"({
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
        })";
    }

    size_t processed = watcher.ProcessOnce(err);
    TEST_ASSERT(processed == 1, "Processed count must be 1");
    TEST_ASSERT(!fs::exists(valid_file), "Spool file must be unlinked after durable commit");

    // 5.3 Коллизия event_id: изоляция файла в Карантин с тегом COLLISION_EVENT_ID
    std::string colliding_file = test_spool + "/20261012143000555_a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d.json";
    {
        std::ofstream ofs(colliding_file);
        ofs << R"({
          "schema_version": "1.0",
          "event_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
          "timestamp_utc": "2026-10-12T14:30:00.555Z",
          "source": "1C_EXTENSION",
          "event_type": "TELEMETRY",
          "priority": "NORMAL",
          "payload": {
            "shop": "Магазин Розница (КОЛЛИЗИЯ)",
            "workplace": "Касса 1"
          }
        })";
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

    queue.Close();
    fs::remove_all(test_spool, ec);
    fs::remove_all(test_quar, ec);
    fs::remove(test_db, ec);
    fs::remove(test_db + "-wal", ec);
    fs::remove(test_db + "-shm", ec);
}

int main() {
    std::cout << "================================================================\n";
    std::cout << "⚡ 1C-NOC WINDOWS AGENT — UNIT TESTS (PHASE 4.2.1 HARDENING)\n";
    std::cout << "================================================================\n\n";

    RUN_TEST(TestJsonParserHardening);
    RUN_TEST(TestSpoolEnvelopeValidation);
    RUN_TEST(TestCryptoSha256);
    RUN_TEST(TestSqliteDurabilityAndCollisions);
    RUN_TEST(TestSpoolWatcherAndQuarantine);

    std::cout << "\n================================================================\n";
    std::cout << "RESULTS: " << g_tests_passed << " PASSED, " << g_tests_failed << " FAILED\n";
    std::cout << "================================================================\n";

    return (g_tests_failed == 0) ? 0 : 1;
}
