#include "spool_watcher.hpp"
#include "crypto_hash.hpp"
#include "json_lite.hpp"
#include <filesystem>
#include <fstream>
#include <algorithm>
#include <system_error>

namespace fs = std::filesystem;

namespace noc::spool {

SpoolWatcher::SpoolWatcher(std::string spool_dir, std::string quarantine_dir, db::SqliteQueue& queue)
    : spool_dir_(std::move(spool_dir)),
      quarantine_dir_(std::move(quarantine_dir)),
      queue_(queue) {
#ifdef _WIN32
    stop_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
#endif
}

SpoolWatcher::~SpoolWatcher() {
    Stop();
#ifdef _WIN32
    if (stop_event_) {
        CloseHandle(stop_event_);
        stop_event_ = nullptr;
    }
#endif
}

bool SpoolWatcher::Initialize(std::string& out_error) {
    try {
        if (!fs::exists(spool_dir_)) {
            fs::create_directories(spool_dir_);
        }
        if (!fs::exists(quarantine_dir_)) {
            fs::create_directories(quarantine_dir_);
        }
    } catch (const std::exception& ex) {
        out_error = std::string("Filesystem init error: ") + ex.what();
        return false;
    }
    return true;
}

void SpoolWatcher::Start() {
    if (is_running_.load()) return;
    is_running_.store(true);
    stop_requested_.store(false);

    worker_thread_ = std::thread(&SpoolWatcher::WatcherLoop, this);
}

void SpoolWatcher::Stop() {
    if (!is_running_.load()) return;
    stop_requested_.store(true);

#ifdef _WIN32
    if (stop_event_) {
        SetEvent(stop_event_);
    }
#endif

    if (worker_thread_.joinable()) {
        worker_thread_.join();
    }
    is_running_.store(false);
}

bool SpoolWatcher::QuarantineFile(const std::string& filepath, const std::string& reason, std::string& out_error) {
    try {
        fs::path src(filepath);
        if (!fs::exists(src)) {
            out_error = "Source file does not exist";
            return false;
        }

        auto now = std::chrono::system_clock::now();
        auto tt = std::chrono::system_clock::to_time_t(now);
        std::tm tm_buf{};
#if defined(_WIN32)
        gmtime_s(&tm_buf, &tt);
#else
        gmtime_r(&tt, &tm_buf);
#endif
        char ts_buf[32];
        std::strftime(ts_buf, sizeof(ts_buf), "%Y%m%d%H%M%S", &tm_buf);

        std::string dst_filename = std::string(ts_buf) + "_" + reason + "_" + src.filename().string();
        fs::path dst = fs::path(quarantine_dir_) / dst_filename;

        // Перемещение в карантин
        std::error_code ec;
        fs::rename(src, dst, ec);
        if (ec) {
            // Если переименование между томами или занято, копируем и удаляем
            fs::copy_file(src, dst, fs::copy_options::overwrite_existing, ec);
            if (!ec) {
                fs::remove(src, ec);
            }
        }

        if (ec) {
            out_error = "Failed to quarantine file: " + ec.message();
            return false;
        }

        Log(LogLevel::WARN_LVL, "Quarantined file " + src.filename().string() + 
                                " -> " + dst_filename + " (reason: " + reason + ")");
        return true;
    } catch (const std::exception& ex) {
        out_error = ex.what();
        return false;
    }
}

size_t SpoolWatcher::SweepStaleTmpFiles(int64_t max_age_seconds) {
    size_t removed_count = 0;
    try {
        if (!fs::exists(spool_dir_)) return 0;

        auto now = fs::file_time_type::clock::now();

        for (const auto& entry : fs::directory_iterator(spool_dir_)) {
            if (!entry.is_regular_file()) continue;

            std::string filename = entry.path().filename().string();
            // Ищем временные файлы temp_*.tmp
            if (filename.rfind("temp_", 0) == 0 && entry.path().extension() == ".tmp") {
                auto last_write = entry.last_write_time();
                auto age_sec = std::chrono::duration_cast<std::chrono::seconds>(now - last_write).count();

                if (age_sec > max_age_seconds) {
                    std::error_code ec;
                    fs::remove(entry.path(), ec);
                    if (!ec) {
                        removed_count++;
                        Log(LogLevel::WARN_LVL, "Crash Recovery: removed stale temp file: " + 
                                                filename + " (age: " + std::to_string(age_sec) + "s)");
                    }
                }
            }
        }
    } catch (const std::exception& ex) {
        Log(LogLevel::ERROR_LVL, "Error sweeping stale tmp files: " + std::string(ex.what()));
    }
    return removed_count;
}

IngestResult SpoolWatcher::ProcessSingleFile(const std::string& filepath, const std::string& filename) {
    try {
        fs::path p(filepath);
        if (!fs::exists(p)) return IngestResult::ERROR_IO;

        // 1. Проверка размера файла
        auto file_size = fs::file_size(p);
        if (file_size > MAX_PAYLOAD_BYTES) {
            std::string q_err;
            QuarantineFile(filepath, "OVERSIZED_64KB", q_err);
            return IngestResult::QUARANTINED_OVERSIZED;
        }

        if (file_size == 0) {
            // Файл нулевого размера может быть в процессе записи, пропускаем на короткое время
            return IngestResult::SKIPPED_IN_FLIGHT;
        }

        // 2. Чтение содержимого файла
        std::ifstream ifs(filepath, std::ios::binary);
        if (!ifs.is_open()) {
            return IngestResult::ERROR_IO;
        }

        std::string content((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
        ifs.close();

        // 3. Валидация конверта Spool Envelope v1.0
        SpoolEnvelope envelope;
        envelope.source_filename = filename;
        std::string parse_err;

        if (!json::Parser::ParseSpoolEnvelope(content, envelope, parse_err)) {
            std::string q_err;
            QuarantineFile(filepath, "INVALID_ENVELOPE", q_err);
            Log(LogLevel::ERROR_LVL, "Invalid envelope in " + filename + ": " + parse_err);
            return IngestResult::QUARANTINED_INVALID;
        }

        // 4. Расчет хеша SHA-256
        envelope.sha256_hash = crypto::ComputeSha256(content);

        // 5. Вставка в SQLite очередь
        auto res = queue_.Enqueue(envelope);

        if (res.status == db::EnqueueStatus::SUCCESS_INSERTED) {
            // Успешно сохранено в БД -> безопасно удаляем из каталога очереди
            std::error_code ec;
            fs::remove(p, ec);
            if (ec) {
                Log(LogLevel::ERROR_LVL, "Failed to remove spool file after DB insert: " + ec.message());
            } else {
                Log(LogLevel::INFO_LVL, "Ingested event: " + envelope.event_id + 
                                        " [" + envelope.priority + "] from " + filename);
            }
            return IngestResult::INGESTED_SUCCESS;
        } else if (res.status == db::EnqueueStatus::DUPLICATE_IGNORED) {
            // Уже сохранено в БД (идемпотентный повтор после сбоя) -> удаляем файл из spool
            std::error_code ec;
            fs::remove(p, ec);
            Log(LogLevel::INFO_LVL, "Duplicate event cleaned: " + envelope.event_id + 
                                    " (hash: " + envelope.sha256_hash.substr(0, 8) + "...)");
            return IngestResult::DUPLICATE_CLEANED;
        } else {
            // Ошибка БД или исчерпание лимита -> оставляем файл в spool для повтора
            Log(LogLevel::ERROR_LVL, "Failed to enqueue " + filename + ": " + res.message);
            return IngestResult::RETRY_LATER;
        }

    } catch (const std::exception& ex) {
        Log(LogLevel::ERROR_LVL, "Exception processing " + filename + ": " + ex.what());
        return IngestResult::ERROR_IO;
    }
}

size_t SpoolWatcher::ProcessOnce(std::string& out_error) {
    size_t processed_count = 0;
    try {
        if (!fs::exists(spool_dir_)) {
            out_error = "Spool directory does not exist: " + spool_dir_;
            return 0;
        }

        // Собираем все готовые .json файлы
        std::vector<std::string> json_files;
        for (const auto& entry : fs::directory_iterator(spool_dir_)) {
            if (!entry.is_regular_file()) continue;

            std::string filename = entry.path().filename().string();
            // Игнорируем .tmp и in-flight файлы
            if (filename.rfind("temp_", 0) == 0 || entry.path().extension() == ".tmp") {
                continue;
            }

            if (entry.path().extension() == ".json") {
                json_files.push_back(filename);
            }
        }

        // Лексикографическая сортировка обеспечивает строгий порядок FIFO по временной метке UTC!
        std::sort(json_files.begin(), json_files.end());

        for (const auto& filename : json_files) {
            fs::path full_path = fs::path(spool_dir_) / filename;
            auto res = ProcessSingleFile(full_path.string(), filename);
            if (res == IngestResult::INGESTED_SUCCESS || res == IngestResult::DUPLICATE_CLEANED) {
                processed_count++;
            }
        }

    } catch (const std::exception& ex) {
        out_error = ex.what();
    }
    return processed_count;
}

void SpoolWatcher::WatcherLoop() {
    Log(LogLevel::INFO_LVL, "SpoolWatcher thread started on " + spool_dir_);

    // Первоначальный sweep старых .tmp файлов
    SweepStaleTmpFiles();

    auto last_tmp_sweep = std::chrono::steady_clock::now();

#ifdef _WIN32
    // Нативный Windows мониторинг через ReadDirectoryChangesW
    std::wstring w_spool_dir(spool_dir_.begin(), spool_dir_.end());
    HANDLE dir_handle = CreateFileW(
        w_spool_dir.c_str(),
        FILE_LIST_DIRECTORY,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
        nullptr
    );

    if (dir_handle != INVALID_HANDLE_VALUE) {
        uint8_t notify_buf[4096];
        OVERLAPPED ov{};
        ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);

        while (!stop_requested_.load()) {
            ResetEvent(ov.hEvent);
            DWORD bytes_ret = 0;
            BOOL ok = ReadDirectoryChangesW(
                dir_handle,
                notify_buf,
                sizeof(notify_buf),
                FALSE, // только сам каталог spool
                FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE,
                &bytes_ret,
                &ov,
                nullptr
            );

            HANDLE wait_handles[2] = { stop_event_, ov.hEvent };
            DWORD wait_res = WaitForMultipleObjects(2, wait_handles, FALSE, FALLBACK_POLL_INTERVAL_MS);

            if (wait_res == WAIT_OBJECT_0) {
                // stop_event сигнален
                CancelIo(dir_handle);
                break;
            }

            // Обработка очереди при событии либо по таймауту (fallback poll)
            std::string err;
            ProcessOnce(err);

            // Периодический sweep старых .tmp файлов
            auto now = std::chrono::steady_clock::now();
            if (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_tmp_sweep).count() >= TMP_SWEEP_INTERVAL_MS) {
                SweepStaleTmpFiles();
                last_tmp_sweep = now;
            }
        }

        if (ov.hEvent) CloseHandle(ov.hEvent);
        CloseHandle(dir_handle);
        Log(LogLevel::INFO_LVL, "SpoolWatcher loop finished cleanly");
        return;
    }
#endif

    // Fallback цикл для не-Windows или при недоступности дескриптора каталога
    while (!stop_requested_.load()) {
        std::string err;
        ProcessOnce(err);

        auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_tmp_sweep).count() >= TMP_SWEEP_INTERVAL_MS) {
            SweepStaleTmpFiles();
            last_tmp_sweep = now;
        }

        // Сон с проверкой флага завершения
        for (uint32_t i = 0; i < FALLBACK_POLL_INTERVAL_MS / 100; ++i) {
            if (stop_requested_.load()) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }

    Log(LogLevel::INFO_LVL, "SpoolWatcher loop finished cleanly");
}

} // namespace noc::spool
