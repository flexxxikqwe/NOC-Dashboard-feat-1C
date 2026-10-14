#pragma once

#include "common.hpp"
#include <string>
#include <vector>
#include <memory>
#include <mutex>

// Предварительное объявление sqlite3, чтобы не требовать заголовка в hpp
struct sqlite3;
struct sqlite3_stmt;

namespace noc::db {

enum class EnqueueStatus {
    SUCCESS_INSERTED,
    DUPLICATE_IGNORED,     // Хеш SHA-256 уже существует в БД (идемпотентный повтор)
    COLLISION_DETECTED,    // Один и тот же event_id, но с разным SHA-256
    DATABASE_ERROR,
    CAPACITY_EXCEEDED
};

struct EnqueueResult {
    EnqueueStatus status = EnqueueStatus::DATABASE_ERROR;
    int64_t record_id = 0;
    std::string message;
};

class SqliteQueue {
public:
    SqliteQueue();
    ~SqliteQueue();

    SqliteQueue(const SqliteQueue&) = delete;
    SqliteQueue& operator=(const SqliteQueue&) = delete;

    // Открытие базы данных и создание схемы
    bool Open(const std::string& db_path, std::string& out_error);
    void Close();

    [[nodiscard]] bool IsOpen() const { return db_ != nullptr; }

    // Помещение пакета в очередь с дедупликацией по SHA-256 и транзакцией
    EnqueueResult Enqueue(const SpoolEnvelope& envelope);

    // Извлечение ожидающих отправки записей с учетом приоритета
    bool GetPending(size_t limit, std::vector<QueueRecord>& out_records, std::string& out_error);

    // Обновление статуса записи ("PENDING", "PROCESSING", "SENT", "FAILED")
    bool UpdateStatus(int64_t id, const std::string& status, std::string& out_error);

    // Увеличение счетчика попыток
    bool IncrementRetry(int64_t id, std::string& out_error);

    // Получение статистики очереди (количество и размер в байтах)
    bool GetStats(size_t& out_count, int64_t& out_db_bytes, std::string& out_error);

    // Принудительное вытеснение по лимиту 10 МБ (Priority Eviction)
    bool EnforceCapacity(int64_t max_bytes, std::string& out_error);

    // Очистка успешно доставленных старых записей
    bool PruneSent(int64_t older_than_seconds, std::string& out_error);

    // Выполнение пассивного checkpoint для удержания размера WAL в границах
    bool Checkpoint(std::string& out_error);

    // Проверка целостности БД (quick_check)
    bool CheckIntegrity(std::string& out_error);

private:
    bool Execute(const char* sql, std::string& out_error);
    int64_t GetDatabaseFileSizeBytes();

    sqlite3* db_ = nullptr;
    std::string db_path_;
    mutable std::mutex mutex_;
};

} // namespace noc::db
