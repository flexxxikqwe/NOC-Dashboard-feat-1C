#pragma once

#include "common.hpp"
#include "sqlite_queue.hpp"
#include "raii_handles.hpp"
#include <string>
#include <vector>
#include <atomic>
#include <thread>
#include <chrono>

namespace noc::spool {

// Результат обработки отдельного файла очереди
enum class IngestResult {
    INGESTED_SUCCESS,
    DUPLICATE_CLEANED,
    QUARANTINED_INVALID,
    QUARANTINED_OVERSIZED,
    SKIPPED_IN_FLIGHT,
    RETRY_LATER,
    ERROR_IO
};

class SpoolWatcher {
public:
    SpoolWatcher(std::string spool_dir, std::string quarantine_dir, db::SqliteQueue& queue);
    ~SpoolWatcher();

    SpoolWatcher(const SpoolWatcher&) = delete;
    SpoolWatcher& operator=(const SpoolWatcher&) = delete;

    // Инициализация (проверка/создание каталогов)
    bool Initialize(std::string& out_error);

    // Запуск фонового потока наблюдения (ReadDirectoryChangesW + fallback poll)
    void Start();

    // Остановка наблюдения
    void Stop();

    // Однократный проход обработки (для тестов, run-once и консоли)
    size_t ProcessOnce(std::string& out_error);

    // Очистка зависших temp_*.tmp файлов старше 5 минут (Crash Recovery)
    size_t SweepStaleTmpFiles(int64_t max_age_seconds = TMP_CLEANUP_AGE_SECONDS);

    // Перемещение поврежденного файла в карантин
    bool QuarantineFile(const std::string& filepath, const std::string& reason, std::string& out_error);

    [[nodiscard]] bool IsRunning() const { return is_running_.load(); }
    [[nodiscard]] const std::string& GetSpoolDir() const { return spool_dir_; }
    [[nodiscard]] const std::string& GetQuarantineDir() const { return quarantine_dir_; }

private:
    void WatcherLoop();
    IngestResult ProcessSingleFile(const std::string& filepath, const std::string& filename);

    std::string spool_dir_;
    std::string quarantine_dir_;
    db::SqliteQueue& queue_;
    std::atomic<bool> is_running_{false};
    std::atomic<bool> stop_requested_{false};
    std::thread worker_thread_;

#ifdef _WIN32
    HANDLE stop_event_ = NULL;
#endif
};

} // namespace noc::spool
