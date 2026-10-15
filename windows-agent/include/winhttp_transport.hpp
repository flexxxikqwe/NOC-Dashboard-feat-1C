#pragma once

#include "common.hpp"
#include "sqlite_queue.hpp"
#include "json_lite.hpp"

#include <string>
#include <vector>
#include <memory>
#include <atomic>
#include <thread>
#include <mutex>
#include <chrono>
#include <functional>

namespace noc::transport {

// ============================================================================
// Конфигурация транспорта WinHTTP
// ============================================================================

struct TransportConfig {
    std::string server_url;
    std::string token;
    bool enabled = false;                     // ВЫКЛЮЧЕН ПО УМОЛЧАНИЮ (Phase 4.3 Safe Rollout)
    bool allow_insecure_http = false;         // Запрещен HTTP по умолчанию (только HTTPS)
    uint32_t poll_interval_ms = 10000;        // 10 секунд между опросами очереди
    uint32_t resolve_timeout_ms = 5000;       // DNS таймаут 5 с
    uint32_t connect_timeout_ms = 5000;       // TCP connect таймаут 5 с
    uint32_t send_timeout_ms = 10000;         // Send таймаут 10 с
    uint32_t receive_timeout_ms = 10000;      // Receive таймаут 10 с
    size_t max_response_bytes = 65536;        // Защита от переполнения памяти: макс. 64 КБ ответ
    int max_retries = 10;                     // Порог повторов до перевода в статус FAILED
    std::string remote_type = "NONE";
    std::string remote_id = "";

    bool operator==(const TransportConfig& o) const {
        return server_url == o.server_url &&
               token == o.token &&
               enabled == o.enabled &&
               allow_insecure_http == o.allow_insecure_http &&
               poll_interval_ms == o.poll_interval_ms &&
               resolve_timeout_ms == o.resolve_timeout_ms &&
               connect_timeout_ms == o.connect_timeout_ms &&
               send_timeout_ms == o.send_timeout_ms &&
               receive_timeout_ms == o.receive_timeout_ms &&
               max_response_bytes == o.max_response_bytes &&
               max_retries == o.max_retries &&
               remote_type == o.remote_type &&
               remote_id == o.remote_id;
    }
    bool operator!=(const TransportConfig& o) const {
        return !(*this == o);
    }
};

// Результат HTTP-запроса
struct HttpResponse {
    int status_code = 0;                      // 200, 401, 403, 429, 500 и т.д. (0 при сетевой ошибке)
    std::string body;                         // Тело ответа
    std::string error_message;                // Текст сетевой ошибки (без секретов!)
    int retry_after_seconds = 0;              // Распарсенный заголовок Retry-After
    bool network_error = false;               // Флаг сетевого сбоя / таймаута / разрыва
};

// ============================================================================
// Интерфейс HTTP-клиента (точка подмены для тестов без Windows API)
// ============================================================================

class IHttpClient {
public:
    virtual ~IHttpClient() = default;

    virtual HttpResponse Post(
        const std::string& url,
        const std::string& bearer_token,
        const std::string& json_payload,
        uint32_t timeout_ms
    ) = 0;

    virtual void Abort() = 0;
};

// ============================================================================
// Mock HTTP-клиент для кросс-платформенного тестирования и CI
// ============================================================================

class MockHttpClient : public IHttpClient {
public:
    using HandlerFunc = std::function<HttpResponse(
        const std::string& url,
        const std::string& token,
        const std::string& payload
    )>;

    MockHttpClient() = default;
    explicit MockHttpClient(HandlerFunc handler) : handler_(std::move(handler)) {}

    void SetHandler(HandlerFunc handler) {
        std::lock_guard<std::mutex> lock(mutex_);
        handler_ = std::move(handler);
    }

    HttpResponse Post(
        const std::string& url,
        const std::string& bearer_token,
        const std::string& json_payload,
        uint32_t timeout_ms
    ) override;

    void Abort() override;
    void ResetAbort();
    bool IsAborted() const;

    size_t GetCallCount() const;
    std::string GetLastUrl() const;
    std::string GetLastPayload() const;
    std::string GetLastToken() const;

private:
    mutable std::mutex mutex_;
    HandlerFunc handler_;
    bool aborted_ = false;
    size_t call_count_ = 0;
    std::string last_url_;
    std::string last_payload_;
    std::string last_token_;
};

#ifdef _WIN32
// ============================================================================
// Нативная реализация WinHTTP для Windows Service
// ============================================================================

class WinHttpClient : public IHttpClient {
public:
    WinHttpClient();
    ~WinHttpClient() override;

    HttpResponse Post(
        const std::string& url,
        const std::string& bearer_token,
        const std::string& json_payload,
        uint32_t timeout_ms
    ) override;

    void Abort() override;

private:
    void* session_handle_ = nullptr; // HINTERNET
    std::atomic<void*> current_request_{nullptr};
    std::mutex session_mutex_;
};
#endif

// ============================================================================
// Вспомогательные функции трансформации и парсинга
// ============================================================================

// Трансформация SpoolEnvelope в серверный Ingestion Payload (POST /api/v1/telemetry)
std::string EnvelopeToIngestionPayload(
    const SpoolEnvelope& env,
    const std::string& remote_type = "NONE",
    const std::string& remote_id = ""
);

// Безопасное маскирование токена в диагностических логах
std::string MaskTokenForLog(const std::string& token);

// Разбор URL на составные части: схема, хост, порт, путь
bool ParseHttpUrl(
    const std::string& url,
    bool& out_is_https,
    std::string& out_host,
    uint16_t& out_port,
    std::string& out_path,
    std::string& out_error
);

// ============================================================================
// Менеджер асинхронного фонового транспорта (TransportManager)
// ============================================================================

class TransportManager {
public:
    TransportManager(db::SqliteQueue& queue, std::shared_ptr<IHttpClient> client = nullptr);
    ~TransportManager();

    TransportManager(const TransportManager&) = delete;
    TransportManager& operator=(const TransportManager&) = delete;

    // Загрузка конфигурации из JSON файла и переменных окружения
    bool LoadConfig(const std::string& config_path, std::string& out_error);
    void SetConfig(const TransportConfig& config);
    TransportConfig GetConfig() const;

    // Управление фоновым потоком
    void Start();
    void Stop();
    bool IsRunning() const { return is_running_.load(); }

    // Однократный проход отправки пачки (для тестов и контролируемого прогона)
    size_t ProcessPendingBatch(std::string& out_error);

    // Расчет экспоненциального бэкоффа: min(2^min(retry, 6) * 5, 300) секунд
    static int CalculateBackoffSeconds(int retry_count, int retry_after_header = 0);

    // Проверка активности режима ожидания (backoff) и его сброс
    bool IsInBackoff() const;
    int GetRemainingBackoffSeconds() const;
    void ResetBackoff();

private:
    void WorkerLoop();

    db::SqliteQueue& queue_;
    std::shared_ptr<IHttpClient> client_;
    TransportConfig config_;

    std::atomic<bool> is_running_{false};
    std::atomic<bool> stop_requested_{false};
    std::thread worker_thread_;

    std::chrono::steady_clock::time_point backoff_until_{};
    mutable std::mutex mutex_;
};

} // namespace noc::transport
