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
// ТЕСТ 1: Строгий парсер JSON и валидация UTF-8 / BOM
// ============================================================================
void TestJsonParser() {
    // 1.1 Валидный JSON
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

    // 1.2 Запрет UTF-8 BOM (0xEF, 0xBB, 0xBF)
    std::string bom_json = "\xEF\xBB\xBF{\"key\":\"value\"}";
    json::Value bom_val;
    TEST_ASSERT(!json::Parser::Parse(bom_json, bom_val, err), "JSON with BOM must be rejected");
    TEST_ASSERT(err.find("BOM") != std::string::npos, "Error must mention BOM");

    // 1.3 Запрет поврежденного UTF-8
    std::string bad_utf8 = "{\"text\":\"\xFF\xFE bad\"}";
    json::Value bad_val;
    TEST_ASSERT(!json::Parser::Parse(bad_utf8, bad_val, err), "Invalid UTF-8 must be rejected");

    // 1.4 Запрет завершающих запятых (Trailing comma)
    std::string trailing_comma = "{\"a\": 1, }";
    TEST_ASSERT(!json::Parser::Parse(trailing_comma, bad_val, err), "Trailing comma in object must be rejected");

    std::string trailing_arr = "[1, 2, ]";
    TEST_ASSERT(!json::Parser::Parse(trailing_arr, bad_val, err), "Trailing comma in array must be rejected");

    // 1.5 Запрет ведущих нулей в числах
    std::string leading_zero = "{\"val\": 0123}";
    TEST_ASSERT(!json::Parser::Parse(leading_zero, bad_val, err), "Leading zero numbers must be rejected");
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

    // 2.4 Неверный формат event_id (не GUID)
    std::string bad_guid = valid_envelope_json;
    bad_guid.replace(bad_guid.find("a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d"), 36, "invalid-guid-123");
    TEST_ASSERT(!json::Parser::ParseSpoolEnvelope(bad_guid, env, err), "Invalid GUID must be rejected");

    // 2.5 Отсутствие обязательного поля payload.shop
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

    // 2.6 Пакет более 64 КБ (65 536 байт)
    std::string huge_padding(70000, 'A');
    std::string oversized = "{\"schema_version\":\"1.0\",\"event_id\":\"a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d\",\"timestamp_utc\":\"2026-10-12T14:30:00Z\",\"source\":\"1C_EXTENSION\",\"event_type\":\"TELEMETRY\",\"priority\":\"NORMAL\",\"payload\":{\"shop\":\"S\",\"workplace\":\"W\",\"pad\":\"" + huge_padding + "\"}}";
    TEST_ASSERT(!json::Parser::ParseSpoolEnvelope(oversized, env, err), "Oversized >64KB envelope must be rejected");
}

// ============================================================================
// ТЕСТ 3: SHA-256 хеширование
// ============================================================================
void TestCryptoSha256() {
    // Тестовый вектор NIST для "abc"
    // ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    std::string h1 = crypto::ComputeSha256("abc");
    TEST_ASSERT(h1 == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", 
                "SHA-256 for 'abc' must match NIST standard");

    // Пустая строка: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    std::string h_empty = crypto::ComputeSha256("");
    TEST_ASSERT(h_empty == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", 
                "SHA-256 for empty string must match NIST standard");
}

// ============================================================================
// ТЕСТ 4: SQLite локальная очередь, транзакции, дедупликация и приоритеты
// ============================================================================
void TestSqliteQueue() {
    std::string test_db = "/tmp/test_noc_queue.db";
    std::error_code ec;
    fs::remove(test_db, ec);
    fs::remove(test_db + "-wal", ec);
    fs::remove(test_db + "-shm", ec);

    db::SqliteQueue queue;
    std::string err;
    TEST_ASSERT(queue.Open(test_db, err), "SQLite DB must open successfully: " + err);

    // 4.1 Вставка новой записи
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

    // 4.2 Дедупликация идентичного SHA-256 (Идемпотентный повтор)
    auto res1_dup = queue.Enqueue(env1);
    TEST_ASSERT(res1_dup.status == db::EnqueueStatus::DUPLICATE_IGNORED, "Duplicate SHA-256 must be ignored");
    TEST_ASSERT(res1_dup.record_id == res1.record_id, "Duplicate must reference existing record ID");

    // 4.3 Приоритеты FIFO выборки (HIGH перед NORMAL перед LOW)
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
    // Первая запись должна быть HIGH приоритета, хотя вставлена позже!
    TEST_ASSERT(pending[0].priority == "HIGH", "First record fetched must have HIGH priority");
    TEST_ASSERT(pending[1].priority == "NORMAL", "Second record fetched must have NORMAL priority");

    // 4.4 Обновление статусов
    TEST_ASSERT(queue.UpdateStatus(pending[0].id, "SENT", err), "UpdateStatus to SENT must succeed");

    std::vector<QueueRecord> pending_after;
    TEST_ASSERT(queue.GetPending(10, pending_after, err), "GetPending must succeed");
    TEST_ASSERT(pending_after.size() == 1, "Only 1 pending record should remain");
    TEST_ASSERT(pending_after[0].id == pending[1].id, "Remaining record must be NORMAL");

    queue.Close();
    fs::remove(test_db, ec);
    fs::remove(test_db + "-wal", ec);
    fs::remove(test_db + "-shm", ec);
}

// ============================================================================
// ТЕСТ 5: SpoolWatcher, Crash Recovery и изоляция Карантина
// ============================================================================
void TestSpoolWatcherAndQuarantine() {
    std::string test_spool = "/tmp/test_noc_spool";
    std::string test_quar = "/tmp/test_noc_quarantine";
    std::string test_db = "/tmp/test_noc_spool_db.db";

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

    // 5.1 Игнорирование temp_*.tmp файлов и удаление зависших .tmp (Crash Recovery)
    std::string stale_tmp = test_spool + "/temp_stale_12345.tmp";
    {
        std::ofstream ofs(stale_tmp);
        ofs << "in-flight data";
    }

    // Устанавливаем время модификации 10 минут назад
    auto old_time = fs::file_time_type::clock::now() - std::chrono::seconds(600);
    fs::last_write_time(stale_tmp, old_time);

    size_t swept = watcher.SweepStaleTmpFiles(300); // порог 5 минут
    TEST_ASSERT(swept == 1, "Must sweep 1 stale temp file");
    TEST_ASSERT(!fs::exists(stale_tmp), "Stale temp file must be deleted");

    // 5.2 Запись валидного опубликованного события <timestamp>_<guid>.json
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
    TEST_ASSERT(!fs::exists(valid_file), "Spool file must be unlinked after successful ingestion");

    // Проверяем наличие в SQLite
    std::vector<QueueRecord> records;
    TEST_ASSERT(queue.GetPending(10, records, err), "GetPending");
    TEST_ASSERT(records.size() == 1, "Queue must have 1 record");
    TEST_ASSERT(records[0].event_id == "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d", "event_id must match");

    // 5.3 Изоляция поврежденного пакета в Карантин (Quarantine)
    std::string corrupt_file = test_spool + "/20261012143000999_b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e.json";
    {
        std::ofstream ofs(corrupt_file);
        ofs << "{ corrupt json: missing quotes and brackets";
    }

    watcher.ProcessOnce(err);
    TEST_ASSERT(!fs::exists(corrupt_file), "Corrupt file must be removed from spool");

    // Проверяем появление в карантине
    bool found_in_quar = false;
    for (const auto& entry : fs::directory_iterator(test_quar)) {
        if (entry.path().filename().string().find("INVALID_ENVELOPE") != std::string::npos) {
            found_in_quar = true;
            break;
        }
    }
    TEST_ASSERT(found_in_quar, "Corrupt file must be moved to quarantine with INVALID_ENVELOPE tag");

    queue.Close();
    fs::remove_all(test_spool, ec);
    fs::remove_all(test_quar, ec);
    fs::remove(test_db, ec);
    fs::remove(test_db + "-wal", ec);
    fs::remove(test_db + "-shm", ec);
}

int main() {
    std::cout << "================================================================\n";
    std::cout << "⚡ 1C-NOC WINDOWS AGENT — UNIT & SUBSYSTEM TESTS (PHASE 4.2)\n";
    std::cout << "================================================================\n\n";

    RUN_TEST(TestJsonParser);
    RUN_TEST(TestSpoolEnvelopeValidation);
    RUN_TEST(TestCryptoSha256);
    RUN_TEST(TestSqliteQueue);
    RUN_TEST(TestSpoolWatcherAndQuarantine);

    std::cout << "\n================================================================\n";
    std::cout << "RESULTS: " << g_tests_passed << " PASSED, " << g_tests_failed << " FAILED\n";
    std::cout << "================================================================\n";

    return (g_tests_failed == 0) ? 0 : 1;
}
