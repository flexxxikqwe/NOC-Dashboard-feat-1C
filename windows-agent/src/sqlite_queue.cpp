#include "sqlite_queue.hpp"
#include "../vendor/sqlite/sqlite3.h"
#include <chrono>
#include <sys/stat.h>

namespace noc::db {

SqliteQueue::SqliteQueue() = default;

SqliteQueue::~SqliteQueue() {
    Close();
}

void SqliteQueue::Close() {
    std::lock_guard<std::mutex> lock(mutex_);
    CloseInternal();
}

void SqliteQueue::CloseInternal() {
    if (db_) {
        sqlite3_close_v2(db_);
        db_ = nullptr;
    }
}

bool SqliteQueue::Execute(const char* sql, std::string& out_error) {
    char* err_msg = nullptr;
    int rc = sqlite3_exec(db_, sql, nullptr, nullptr, &err_msg);
    if (rc != SQLITE_OK) {
        out_error = err_msg ? err_msg : ("SQLite error code " + std::to_string(rc));
        sqlite3_free(err_msg);
        return false;
    }
    return true;
}

int64_t SqliteQueue::GetDatabaseFileSizeBytes() {
    if (db_path_.empty()) return 0;
    int64_t total = 0;
    struct stat st{};
    if (stat(db_path_.c_str(), &st) == 0) {
        total += st.st_size;
    }
    std::string wal_path = db_path_ + "-wal";
    if (stat(wal_path.c_str(), &st) == 0) {
        total += st.st_size;
    }
    std::string shm_path = db_path_ + "-shm";
    if (stat(shm_path.c_str(), &st) == 0) {
        total += st.st_size;
    }
    return total;
}

bool SqliteQueue::CheckIntegrity(std::string& out_error) {
    std::lock_guard<std::mutex> lock(mutex_);
    return CheckIntegrityInternal(out_error);
}

bool SqliteQueue::CheckIntegrityInternal(std::string& out_error) {
    if (!db_) {
        out_error = "Database is not open";
        return false;
    }
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, "PRAGMA quick_check;", -1, &stmt, nullptr) != SQLITE_OK) {
        out_error = sqlite3_errmsg(db_);
        return false;
    }

    bool ok = false;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        const char* res = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        if (res && std::string(res) == "ok") {
            ok = true;
        } else {
            out_error = res ? res : "Integrity check failed";
        }
    }
    sqlite3_finalize(stmt);
    return ok;
}

bool SqliteQueue::Checkpoint(std::string& out_error) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!db_) {
        out_error = "Database is not open";
        return false;
    }
    int log_frames = 0, ckpt_frames = 0;
    int rc = sqlite3_wal_checkpoint_v2(db_, nullptr, SQLITE_CHECKPOINT_PASSIVE, &log_frames, &ckpt_frames);
    if (rc != SQLITE_OK) {
        out_error = sqlite3_errmsg(db_);
        return false;
    }
    return true;
}

bool SqliteQueue::Open(const std::string& db_path, std::string& out_error) {
    std::lock_guard<std::mutex> lock(mutex_);
    CloseInternal();
    db_path_ = db_path;

    int rc = sqlite3_open_v2(
        db_path.c_str(), 
        &db_, 
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, 
        nullptr
    );

    if (rc != SQLITE_OK) {
        out_error = db_ ? sqlite3_errmsg(db_) : "Failed to open SQLite database";
        if (db_) { sqlite3_close_v2(db_); db_ = nullptr; }
        return false;
    }

    // 1. Проверка целостности при открытии
    std::string integ_err;
    if (!CheckIntegrityInternal(integ_err)) {
        out_error = "SQLite startup integrity check failed: " + integ_err;
        sqlite3_close_v2(db_);
        db_ = nullptr;
        return false;
    }

    // 2. Настройка надёжных PRAGMA для POS кассы:
    // Режим WAL для высокой параллельности без взаимных блокировок
    if (!Execute("PRAGMA journal_mode = WAL;", out_error)) return false;

    // КРИТИЧНО ДЛЯ ДОЛГОВЕЧНОСТИ (DURABILITY): synchronous = FULL!
    // В режиме WAL настройка FULL выполняет FlushFileBuffers (fsync) при каждом COMMIT,
    // гарантируя физическую запись на диск ПЕРЕД удалением исходного spool-файла.
    // С учетом частоты телеметрии (раз в 5-10 мин) затраты I/O ~2 мс совершенно незаметны.
    if (!Execute("PRAGMA synchronous = FULL;", out_error)) return false;
    if (!Execute("PRAGMA busy_timeout = 5000;", out_error)) return false;
    if (!Execute("PRAGMA auto_vacuum = INCREMENTAL;", out_error)) return false;
    if (!Execute("PRAGMA wal_autocheckpoint = 1000;", out_error)) return false;

    // 3. Верификация активного режима WAL и synchronous
    sqlite3_stmt* chk_stmt = nullptr;
    if (sqlite3_prepare_v2(db_, "PRAGMA journal_mode;", -1, &chk_stmt, nullptr) == SQLITE_OK) {
        if (sqlite3_step(chk_stmt) == SQLITE_ROW) {
            std::string mode = reinterpret_cast<const char*>(sqlite3_column_text(chk_stmt, 0));
            if (mode != "wal") {
                out_error = "Failed to activate WAL journal_mode: current is " + mode;
                sqlite3_finalize(chk_stmt);
                sqlite3_close_v2(db_);
                db_ = nullptr;
                return false;
            }
        }
        sqlite3_finalize(chk_stmt);
    }

    sqlite3_stmt* sync_stmt = nullptr;
    if (sqlite3_prepare_v2(db_, "PRAGMA synchronous;", -1, &sync_stmt, nullptr) == SQLITE_OK) {
        if (sqlite3_step(sync_stmt) == SQLITE_ROW) {
            int sync_val = sqlite3_column_int(sync_stmt, 0);
            if (sync_val < 2) { // 2 = FULL, 3 = EXTRA
                out_error = "Failed to activate synchronous=FULL: current mode is " + std::to_string(sync_val);
                sqlite3_finalize(sync_stmt);
                sqlite3_close_v2(db_);
                db_ = nullptr;
                return false;
            }
        }
        sqlite3_finalize(sync_stmt);
    }

    // 4. Создание схемы таблицы очереди
    const char* kSchemaSql = 
        "CREATE TABLE IF NOT EXISTS spool_queue ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  event_id TEXT NOT NULL,"
        "  timestamp_utc TEXT NOT NULL,"
        "  sha256 TEXT NOT NULL UNIQUE,"
        "  event_type TEXT NOT NULL,"
        "  priority TEXT NOT NULL,"
        "  payload_json TEXT NOT NULL,"
        "  status TEXT NOT NULL DEFAULT 'PENDING',"
        "  retry_count INTEGER NOT NULL DEFAULT 0,"
        "  created_at INTEGER NOT NULL"
        ");"
        "CREATE INDEX IF NOT EXISTS idx_spool_queue_status_prio ON spool_queue(status, priority, id);"
        "CREATE INDEX IF NOT EXISTS idx_spool_queue_event_id ON spool_queue(event_id);";

    if (!Execute(kSchemaSql, out_error)) {
        return false;
    }

    return true;
}

EnqueueResult SqliteQueue::Enqueue(const SpoolEnvelope& env) {
    std::lock_guard<std::mutex> lock(mutex_);
    EnqueueResult res;
    if (!db_) {
        res.status = EnqueueStatus::DATABASE_ERROR;
        res.message = "Database is not open";
        return res;
    }

    if (env.sha256_hash.size() != 64) {
        res.status = EnqueueStatus::DATABASE_ERROR;
        res.message = "Invalid or missing SHA-256 hash (expected 64 hex characters)";
        return res;
    }

    if (env.event_id.empty()) {
        res.status = EnqueueStatus::DATABASE_ERROR;
        res.message = "Invalid or empty event_id";
        return res;
    }

    // 1. Проверка лимита размера буфера (10 МБ с учетом WAL и SHM)
    std::string cap_err;
    EnforceCapacityInternal(SQLITE_QUEUE_MAX_BYTES, cap_err);

    // 2. Транзакция BEGIN IMMEDIATE для строгой изоляции от конкурирующих писателей
    char* err_msg = nullptr;
    if (sqlite3_exec(db_, "BEGIN IMMEDIATE TRANSACTION;", nullptr, nullptr, &err_msg) != SQLITE_OK) {
        res.status = EnqueueStatus::DATABASE_ERROR;
        res.message = err_msg ? err_msg : "Failed to begin transaction";
        sqlite3_free(err_msg);
        return res;
    }

    // 3. Проверка существования идентичного дубликата по SHA-256 со сравнением содержимого
    const char* kCheckShaSql = "SELECT id, payload_json FROM spool_queue WHERE sha256 = ? LIMIT 1;";
    sqlite3_stmt* check_stmt = nullptr;
    if (sqlite3_prepare_v2(db_, kCheckShaSql, -1, &check_stmt, nullptr) == SQLITE_OK) {
        sqlite3_bind_text(check_stmt, 1, env.sha256_hash.c_str(), -1, SQLITE_STATIC);
        if (sqlite3_step(check_stmt) == SQLITE_ROW) {
            int64_t existing_id = sqlite3_column_int64(check_stmt, 0);
            const char* stored_raw = reinterpret_cast<const char*>(sqlite3_column_text(check_stmt, 1));
            std::string stored_str = stored_raw ? stored_raw : "";
            sqlite3_finalize(check_stmt);
            sqlite3_exec(db_, "COMMIT;", nullptr, nullptr, nullptr);

            if (stored_str == env.raw_json) {
                res.status = EnqueueStatus::DUPLICATE_IGNORED;
                res.record_id = existing_id;
                res.message = "Record with identical SHA-256 and payload already exists (id=" + std::to_string(existing_id) + ")";
                return res;
            } else {
                // Предотвращение ложной дедупликации при коллизии хеша или повреждении
                res.status = EnqueueStatus::COLLISION_DETECTED;
                res.record_id = existing_id;
                res.message = "SHA-256 hash matched existing record (id=" + std::to_string(existing_id) + 
                              ") but payload content differs! Flagged for investigation.";
                Log(LogLevel::WARN_LVL, res.message);
                return res;
            }
        }
        sqlite3_finalize(check_stmt);
    }

    // 4. Проверка коллизии event_id (одинаковый GUID, но разный payload/SHA-256)
    const char* kCheckCollSql = "SELECT id, sha256 FROM spool_queue WHERE event_id = ? AND sha256 != ? LIMIT 1;";
    sqlite3_stmt* coll_stmt = nullptr;
    if (sqlite3_prepare_v2(db_, kCheckCollSql, -1, &coll_stmt, nullptr) == SQLITE_OK) {
        sqlite3_bind_text(coll_stmt, 1, env.event_id.c_str(), -1, SQLITE_STATIC);
        sqlite3_bind_text(coll_stmt, 2, env.sha256_hash.c_str(), -1, SQLITE_STATIC);
        if (sqlite3_step(coll_stmt) == SQLITE_ROW) {
            int64_t collision_id = sqlite3_column_int64(coll_stmt, 0);
            sqlite3_finalize(coll_stmt);
            sqlite3_exec(db_, "ROLLBACK;", nullptr, nullptr, nullptr);
            res.status = EnqueueStatus::COLLISION_DETECTED;
            res.record_id = collision_id;
            res.message = "Collision detected: event_id " + env.event_id + 
                          " already exists with different hash (id=" + std::to_string(collision_id) + ")";
            Log(LogLevel::WARN_LVL, res.message);
            return res;
        }
        sqlite3_finalize(coll_stmt);
    }

    // 5. Вставка новой записи
    const char* kInsertSql = 
        "INSERT INTO spool_queue (event_id, timestamp_utc, sha256, event_type, priority, payload_json, status, retry_count, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?);";

    sqlite3_stmt* insert_stmt = nullptr;
    if (sqlite3_prepare_v2(db_, kInsertSql, -1, &insert_stmt, nullptr) != SQLITE_OK) {
        res.status = EnqueueStatus::DATABASE_ERROR;
        res.message = sqlite3_errmsg(db_);
        sqlite3_exec(db_, "ROLLBACK;", nullptr, nullptr, nullptr);
        return res;
    }

    auto now_epoch = std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::system_clock::now().time_since_epoch()
    ).count();

    sqlite3_bind_text(insert_stmt, 1, env.event_id.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_text(insert_stmt, 2, env.timestamp_utc.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_text(insert_stmt, 3, env.sha256_hash.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_text(insert_stmt, 4, env.event_type.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_text(insert_stmt, 5, env.priority.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_text(insert_stmt, 6, env.raw_json.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_int64(insert_stmt, 7, now_epoch);

    int step_rc = sqlite3_step(insert_stmt);
    if (step_rc == SQLITE_DONE) {
        int64_t new_id = sqlite3_last_insert_rowid(db_);
        sqlite3_finalize(insert_stmt);

        // Фиксация транзакции с FlushFileBuffers (synchronous=FULL)
        char* commit_err = nullptr;
        if (sqlite3_exec(db_, "COMMIT;", nullptr, nullptr, &commit_err) != SQLITE_OK) {
            res.status = EnqueueStatus::DATABASE_ERROR;
            res.message = commit_err ? commit_err : "Failed to commit durable transaction";
            sqlite3_free(commit_err);
            sqlite3_exec(db_, "ROLLBACK;", nullptr, nullptr, nullptr);
            return res;
        }

        res.status = EnqueueStatus::SUCCESS_INSERTED;
        res.record_id = new_id;
        res.message = "Successfully enqueued with id " + std::to_string(new_id);
        return res;
    } else if (step_rc == SQLITE_CONSTRAINT) {
        sqlite3_finalize(insert_stmt);
        sqlite3_exec(db_, "ROLLBACK;", nullptr, nullptr, nullptr);
        res.status = EnqueueStatus::DUPLICATE_IGNORED;
        res.message = "Unique constraint violation on SHA-256";
        return res;
    } else {
        res.status = EnqueueStatus::DATABASE_ERROR;
        res.message = sqlite3_errmsg(db_);
        sqlite3_finalize(insert_stmt);
        sqlite3_exec(db_, "ROLLBACK;", nullptr, nullptr, nullptr);
        return res;
    }
}

bool SqliteQueue::GetPending(size_t limit, std::vector<QueueRecord>& out_records, std::string& out_error) {
    std::lock_guard<std::mutex> lock(mutex_);
    out_records.clear();
    if (!db_) { out_error = "Database is not open"; return false; }

    const char* kSql = 
        "SELECT id, event_id, timestamp_utc, sha256, event_type, priority, payload_json, status, retry_count, created_at "
        "FROM spool_queue "
        "WHERE status = 'PENDING' "
        "ORDER BY "
        "  CASE priority "
        "    WHEN 'HIGH' THEN 1 "
        "    WHEN 'NORMAL' THEN 2 "
        "    WHEN 'LOW' THEN 3 "
        "    ELSE 4 "
        "  END ASC, id ASC "
        "LIMIT ?;";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        out_error = sqlite3_errmsg(db_);
        return false;
    }

    sqlite3_bind_int64(stmt, 1, static_cast<sqlite3_int64>(limit));

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        QueueRecord r;
        r.id = sqlite3_column_int64(stmt, 0);
        r.event_id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
        r.timestamp_utc = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
        r.sha256_hash = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 3));
        r.event_type = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 4));
        r.priority = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 5));
        r.raw_envelope = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 6));
        r.status = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 7));
        r.retry_count = sqlite3_column_int(stmt, 8);
        r.created_at_unix = sqlite3_column_int64(stmt, 9);
        out_records.push_back(std::move(r));
    }

    sqlite3_finalize(stmt);
    return true;
}

bool SqliteQueue::UpdateStatus(int64_t id, const std::string& status, std::string& out_error) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!db_) { out_error = "Database is not open"; return false; }

    const char* kSql = "UPDATE spool_queue SET status = ? WHERE id = ?;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        out_error = sqlite3_errmsg(db_);
        return false;
    }

    sqlite3_bind_text(stmt, 1, status.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_int64(stmt, 2, id);

    int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    if (rc != SQLITE_DONE) {
        out_error = sqlite3_errmsg(db_);
        return false;
    }
    return true;
}

bool SqliteQueue::IncrementRetry(int64_t id, std::string& out_error) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!db_) { out_error = "Database is not open"; return false; }

    const char* kSql = "UPDATE spool_queue SET retry_count = retry_count + 1 WHERE id = ?;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        out_error = sqlite3_errmsg(db_);
        return false;
    }

    sqlite3_bind_int64(stmt, 1, id);
    int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    if (rc != SQLITE_DONE) {
        out_error = sqlite3_errmsg(db_);
        return false;
    }
    return true;
}

bool SqliteQueue::GetStats(size_t& out_count, int64_t& out_db_bytes, std::string& out_error) {
    std::lock_guard<std::mutex> lock(mutex_);
    out_count = 0;
    out_db_bytes = GetDatabaseFileSizeBytes();

    if (!db_) { out_error = "Database is not open"; return false; }

    const char* kSql = "SELECT COUNT(*) FROM spool_queue;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        out_error = sqlite3_errmsg(db_);
        return false;
    }

    if (sqlite3_step(stmt) == SQLITE_ROW) {
        out_count = static_cast<size_t>(sqlite3_column_int64(stmt, 0));
    }
    sqlite3_finalize(stmt);
    return true;
}

bool SqliteQueue::EnforceCapacity(int64_t max_bytes, std::string& out_error) {
    std::lock_guard<std::mutex> lock(mutex_);
    return EnforceCapacityInternal(max_bytes, out_error);
}

bool SqliteQueue::EnforceCapacityInternal(int64_t max_bytes, std::string& out_error) {
    int64_t current_size = GetDatabaseFileSizeBytes();
    if (current_size <= max_bytes) {
        return true;
    }

    Log(LogLevel::WARN_LVL, "Database size (" + std::to_string(current_size) + 
                            " bytes) exceeds limit " + std::to_string(max_bytes) + 
                            " bytes. Executing checkpoint and priority eviction...");

    // Сначала выполняем checkpoint, чтобы ужать WAL
    int log_f = 0, ckpt_f = 0;
    sqlite3_wal_checkpoint_v2(db_, nullptr, SQLITE_CHECKPOINT_PASSIVE, &log_f, &ckpt_f);

    current_size = GetDatabaseFileSizeBytes();
    if (current_size <= max_bytes) {
        return true;
    }

    // Вытеснение: сначала удаляем отправленные (SENT), затем самые старые LOW/NORMAL
    const char* kPruneSent = "DELETE FROM spool_queue WHERE status = 'SENT';";
    Execute(kPruneSent, out_error);

    current_size = GetDatabaseFileSizeBytes();
    if (current_size <= max_bytes) {
        Execute("PRAGMA incremental_vacuum;", out_error);
        return true;
    }

    // Вытеснение устаревшей рутинной телеметрии (TELEMETRY/LOW/NORMAL), сохраняя инциденты (HIGH)
    const char* kEvictOld = 
        "DELETE FROM spool_queue WHERE id IN ("
        "  SELECT id FROM spool_queue "
        "  WHERE priority != 'HIGH' "
        "  ORDER BY id ASC LIMIT 50"
        ");";
    Execute(kEvictOld, out_error);
    Execute("PRAGMA incremental_vacuum;", out_error);

    return true;
}

bool SqliteQueue::PruneSent(int64_t older_than_seconds, std::string& out_error) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!db_) { out_error = "Database is not open"; return false; }

    auto threshold = std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::system_clock::now().time_since_epoch()
    ).count() - older_than_seconds;

    const char* kSql = "DELETE FROM spool_queue WHERE status = 'SENT' AND created_at < ?;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        out_error = sqlite3_errmsg(db_);
        return false;
    }

    sqlite3_bind_int64(stmt, 1, threshold);
    int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    if (rc != SQLITE_DONE) {
        out_error = sqlite3_errmsg(db_);
        return false;
    }
    return true;
}

} // namespace noc::db
