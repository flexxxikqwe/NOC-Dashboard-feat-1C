#include "winhttp_transport.hpp"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>
#include <cstring>

#ifdef _WIN32
  #include <windows.h>
  #include <winhttp.h>
  #pragma comment(lib, "winhttp.lib")
#endif

namespace noc::transport {

// ============================================================================
// Вспомогательные функции
// ============================================================================

std::string MaskTokenForLog(const std::string& token) {
    if (token.empty()) {
        return "(empty)";
    }
    if (token.size() <= 8) {
        return "***";
    }
    return token.substr(0, 3) + "..." + token.substr(token.size() - 2) + 
           " (" + std::to_string(token.size()) + " chars)";
}

bool ParseHttpUrl(
    const std::string& url,
    bool& out_is_https,
    std::string& out_host,
    uint16_t& out_port,
    std::string& out_path,
    std::string& out_error
) {
    if (url.empty()) {
        out_error = "URL is empty";
        return false;
    }

    std::string rest;
    if (url.rfind("https://", 0) == 0) {
        out_is_https = true;
        out_port = 443;
        rest = url.substr(8);
    } else if (url.rfind("http://", 0) == 0) {
        out_is_https = false;
        out_port = 80;
        rest = url.substr(7);
    } else {
        out_error = "Invalid URL scheme: must start with https:// or http://";
        return false;
    }

    if (rest.empty()) {
        out_error = "Missing host in URL";
        return false;
    }

    size_t slash_pos = rest.find('/');
    std::string host_port_part;
    if (slash_pos == std::string::npos) {
        host_port_part = rest;
        out_path = "/";
    } else {
        host_port_part = rest.substr(0, slash_pos);
        out_path = rest.substr(slash_pos);
    }

    size_t colon_pos = host_port_part.find(':');
    if (colon_pos == std::string::npos) {
        out_host = host_port_part;
    } else {
        out_host = host_port_part.substr(0, colon_pos);
        std::string port_str = host_port_part.substr(colon_pos + 1);
        try {
            int p = std::stoi(port_str);
            if (p <= 0 || p > 65535) {
                out_error = "Port out of range: " + port_str;
                return false;
            }
            out_port = static_cast<uint16_t>(p);
        } catch (...) {
            out_error = "Invalid port in URL: " + port_str;
            return false;
        }
    }

    if (out_host.empty()) {
        out_error = "Host is empty";
        return false;
    }

    return true;
}

std::string EnvelopeToIngestionPayload(
    const SpoolEnvelope& env,
    const std::string& remote_type,
    const std::string& remote_id
) {
    json::Object root;
    root["shop"] = env.shop;
    root["workplace"] = env.workplace;

    json::Object remote;
    remote["type"] = remote_type.empty() ? "NONE" : remote_type;
    remote["id"] = remote_id;
    root["remote"] = std::move(remote);

    json::Array warnings_arr;
    for (const auto& w : env.warnings) {
        warnings_arr.push_back(w);
    }
    root["warnings"] = std::move(warnings_arr);

    // Обработка runtime_errors
    if (!env.runtime_errors_raw_json.empty()) {
        json::Value rt_val;
        std::string err;
        if (json::Parser::Parse(env.runtime_errors_raw_json, rt_val, err) && rt_val.IsArray()) {
            root["runtime_errors"] = std::move(rt_val);
        } else {
            root["runtime_errors"] = json::Array{};
        }
    } else {
        root["runtime_errors"] = json::Array{};
    }

    // Обработка health_checks
    if (!env.health_checks_raw_json.empty()) {
        json::Value hc_val;
        std::string err;
        if (json::Parser::Parse(env.health_checks_raw_json, hc_val, err) && hc_val.IsArray()) {
            root["health_checks"] = std::move(hc_val);
        } else {
            root["health_checks"] = json::Array{};
        }
    } else {
        root["health_checks"] = json::Array{};
    }

    // Системная информация
    json::Object sys_info;
    json::Object one_c;
    one_c["platform_version"] = env.one_c_info.platform_version;
    one_c["configuration_name"] = env.one_c_info.configuration_name;
    one_c["computer_name"] = env.one_c_info.computer_name;
    sys_info["one_c"] = std::move(one_c);
    sys_info["agent_version"] = "1.0.0";
    sys_info["event_id"] = env.event_id;
    sys_info["event_type"] = env.event_type;
    sys_info["priority"] = env.priority;
    sys_info["spool_timestamp_utc"] = env.timestamp_utc;

    root["system_info"] = std::move(sys_info);

    return json::Value(std::move(root)).Dump();
}

// ============================================================================
// Реализация MockHttpClient
// ============================================================================

HttpResponse MockHttpClient::Post(
    const std::string& url,
    const std::string& bearer_token,
    const std::string& json_payload,
    uint32_t /*timeout_ms*/
) {
    HandlerFunc handler;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        call_count_++;
        last_url_ = url;
        last_token_ = bearer_token;
        last_payload_ = json_payload;

        if (aborted_) {
            HttpResponse r;
            r.status_code = 0;
            r.network_error = true;
            r.error_message = "Request aborted by shutdown";
            return r;
        }

        handler = handler_;
    }

    if (handler) {
        return handler(url, bearer_token, json_payload);
    }

    HttpResponse def;
    def.status_code = 200;
    def.body = "{\"success\":true,\"workplace_id\":\"wp_mock\",\"incidents_recorded\":0}";
    return def;
}

void MockHttpClient::Abort() {
    std::lock_guard<std::mutex> lock(mutex_);
    aborted_ = true;
}

void MockHttpClient::ResetAbort() {
    std::lock_guard<std::mutex> lock(mutex_);
    aborted_ = false;
}

bool MockHttpClient::IsAborted() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return aborted_;
}

size_t MockHttpClient::GetCallCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return call_count_;
}

std::string MockHttpClient::GetLastUrl() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return last_url_;
}

std::string MockHttpClient::GetLastPayload() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return last_payload_;
}

std::string MockHttpClient::GetLastToken() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return last_token_;
}

// ============================================================================
// Реализация WinHttpClient (Win32 / WinHTTP)
// ============================================================================

#ifdef _WIN32

WinHttpClient::WinHttpClient() {
    std::lock_guard<std::mutex> lock(session_mutex_);
    session_handle_ = ::WinHttpOpen(
        L"1C-NOC-Agent/1.0",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS,
        0
    );

    if (session_handle_) {
        // Явное включение протоколов TLS 1.2 и TLS 1.3 для совместимости с Windows 7 / POSReady 7
        DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
#if defined(WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3)
        protocols |= WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
#endif
        ::WinHttpSetOption(
            session_handle_,
            WINHTTP_OPTION_SECURE_PROTOCOLS,
            &protocols,
            sizeof(protocols)
        );
    }
}

WinHttpClient::~WinHttpClient() {
    Abort();
    std::lock_guard<std::mutex> lock(session_mutex_);
    if (session_handle_) {
        ::WinHttpCloseHandle(session_handle_);
        session_handle_ = nullptr;
    }
}

void WinHttpClient::Abort() {
    void* req = current_request_.exchange(nullptr);
    if (req) {
        ::WinHttpCloseHandle(req);
    }
}

HttpResponse WinHttpClient::Post(
    const std::string& url,
    const std::string& bearer_token,
    const std::string& json_payload,
    uint32_t timeout_ms
) {
    HttpResponse resp;

    bool is_https = true;
    std::string host, path, url_err;
    uint16_t port = 443;
    if (!ParseHttpUrl(url, is_https, host, port, path, url_err)) {
        resp.status_code = 0;
        resp.network_error = true;
        resp.error_message = "URL parse failed: " + url_err;
        return resp;
    }

    std::lock_guard<std::mutex> lock(session_mutex_);
    if (!session_handle_) {
        resp.status_code = 0;
        resp.network_error = true;
        resp.error_message = "WinHTTP session is not initialized";
        return resp;
    }

    // Настройка таймаутов DNS, Connect, Send, Receive
    int half_t = static_cast<int>(timeout_ms / 2);
    ::WinHttpSetTimeouts(
        session_handle_,
        std::min(5000, half_t),
        std::min(5000, half_t),
        static_cast<int>(timeout_ms),
        static_cast<int>(timeout_ms)
    );

    std::wstring w_host(host.begin(), host.end());
    HINTERNET hConnect = ::WinHttpConnect(
        session_handle_,
        w_host.c_str(),
        port,
        0
    );

    if (!hConnect) {
        resp.status_code = 0;
        resp.network_error = true;
        resp.error_message = "WinHttpConnect failed: error code " + std::to_string(::GetLastError());
        return resp;
    }

    std::wstring w_path(path.begin(), path.end());
    DWORD flags = is_https ? WINHTTP_FLAG_SECURE : 0;

    HINTERNET hRequest = ::WinHttpOpenRequest(
        hConnect,
        L"POST",
        w_path.c_str(),
        nullptr,
        WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES,
        flags
    );

    if (!hRequest) {
        ::WinHttpCloseHandle(hConnect);
        resp.status_code = 0;
        resp.network_error = true;
        resp.error_message = "WinHttpOpenRequest failed: error code " + std::to_string(::GetLastError());
        return resp;
    }

    current_request_.store(hRequest);

    // Заголовки Content-Type и Authorization
    std::wstring headers = L"Content-Type: application/json; charset=utf-8\r\n";
    if (!bearer_token.empty()) {
        std::wstring w_token(bearer_token.begin(), bearer_token.end());
        headers += L"Authorization: Bearer " + w_token + L"\r\n";
    }

    BOOL send_ok = ::WinHttpSendRequest(
        hRequest,
        headers.c_str(),
        static_cast<DWORD>(headers.size()),
        const_cast<char*>(json_payload.data()),
        static_cast<DWORD>(json_payload.size()),
        static_cast<DWORD>(json_payload.size()),
        0
    );

    if (!send_ok) {
        DWORD err = ::GetLastError();
        current_request_.store(nullptr);
        ::WinHttpCloseHandle(hRequest);
        ::WinHttpCloseHandle(hConnect);
        resp.status_code = 0;
        resp.network_error = true;
        resp.error_message = "WinHttpSendRequest failed: error code " + std::to_string(err);
        return resp;
    }

    BOOL recv_ok = ::WinHttpReceiveResponse(hRequest, nullptr);
    if (!recv_ok) {
        DWORD err = ::GetLastError();
        current_request_.store(nullptr);
        ::WinHttpCloseHandle(hRequest);
        ::WinHttpCloseHandle(hConnect);
        resp.status_code = 0;
        resp.network_error = true;
        resp.error_message = "WinHttpReceiveResponse failed: error code " + std::to_string(err);
        return resp;
    }

    // Чтение HTTP статус-кода
    DWORD status_code = 0;
    DWORD status_size = sizeof(status_code);
    ::WinHttpQueryHeaders(
        hRequest,
        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX,
        &status_code,
        &status_size,
        WINHTTP_NO_HEADER_INDEX
    );
    resp.status_code = static_cast<int>(status_code);

    // Чтение заголовка Retry-After (при 429 или 503)
    wchar_t retry_buf[32] = {0};
    DWORD retry_size = sizeof(retry_buf);
    if (::WinHttpQueryHeaders(
        hRequest,
        WINHTTP_QUERY_CUSTOM,
        L"Retry-After",
        retry_buf,
        &retry_size,
        WINHTTP_NO_HEADER_INDEX
    )) {
        try {
            resp.retry_after_seconds = std::stoi(std::wstring(retry_buf));
        } catch (...) {
            resp.retry_after_seconds = 0;
        }
    }

    // Чтение тела ответа (с лимитом 64 КБ)
    std::string body;
    DWORD bytes_available = 0;
    size_t total_read = 0;
    const size_t kMaxRespBytes = 65536;

    while (::WinHttpQueryDataAvailable(hRequest, &bytes_available) && bytes_available > 0) {
        if (total_read + bytes_available > kMaxRespBytes) {
            bytes_available = static_cast<DWORD>(kMaxRespBytes - total_read);
        }
        std::vector<char> buf(bytes_available);
        DWORD bytes_read = 0;
        if (::WinHttpReadData(hRequest, buf.data(), bytes_available, &bytes_read) && bytes_read > 0) {
            body.append(buf.data(), bytes_read);
            total_read += bytes_read;
        }
        if (total_read >= kMaxRespBytes) {
            break;
        }
    }

    resp.body = std::move(body);

    current_request_.store(nullptr);
    ::WinHttpCloseHandle(hRequest);
    ::WinHttpCloseHandle(hConnect);

    return resp;
}

#endif // _WIN32

// ============================================================================
// Реализация TransportManager
// ============================================================================

TransportManager::TransportManager(db::SqliteQueue& queue, std::shared_ptr<IHttpClient> client)
    : queue_(queue), client_(std::move(client)) {
#ifdef _WIN32
    if (!client_) {
        client_ = std::make_shared<WinHttpClient>();
    }
#else
    if (!client_) {
        client_ = std::make_shared<MockHttpClient>();
    }
#endif
}

TransportManager::~TransportManager() {
    Stop();
}

bool TransportManager::LoadConfig(const std::string& config_path, std::string& out_error) {
    std::lock_guard<std::mutex> lock(mutex_);

    // 1. Попытка чтения config.json
    if (!config_path.empty()) {
        std::ifstream ifs(config_path);
        if (ifs.is_open()) {
            std::string content((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
            ifs.close();

            json::Value root;
            std::string parse_err;
            if (json::Parser::Parse(content, root, parse_err) && root.IsObject()) {
                if (const auto* s = root.Find("server_url")) {
                    if (s->IsString()) config_.server_url = s->AsString();
                }
                if (const auto* t = root.Find("token")) {
                    if (t->IsString()) config_.token = t->AsString();
                }
                if (const auto* en = root.Find("enable_http_transport")) {
                    if (en->IsBool()) config_.enabled = en->AsBool();
                }
                if (const auto* sec = root.Find("allow_insecure_http")) {
                    if (sec->IsBool()) config_.allow_insecure_http = sec->AsBool();
                }
                if (const auto* p = root.Find("poll_interval_ms")) {
                    if (p->IsNumber() && p->AsInt64() >= 1000) {
                        config_.poll_interval_ms = static_cast<uint32_t>(p->AsInt64());
                    }
                }
                if (const auto* rt = root.Find("remote_type")) {
                    if (rt->IsString()) config_.remote_type = rt->AsString();
                }
                if (const auto* ri = root.Find("remote_id")) {
                    if (ri->IsString()) config_.remote_id = ri->AsString();
                }
            } else {
                Log(LogLevel::WARN_LVL, "Failed to parse config file " + config_path + ": " + parse_err);
            }
        }
    }

    // 2. Переопределение переменными окружения
    const char* env_url = std::getenv("NOC_SERVER_URL");
    if (env_url && std::strlen(env_url) > 0) {
        config_.server_url = env_url;
    }

    const char* env_tok = std::getenv("NOC_TOKEN");
    if (!env_tok || std::strlen(env_tok) == 0) {
        env_tok = std::getenv("NOC_DEVICE_TOKEN");
    }
    if (env_tok && std::strlen(env_tok) > 0) {
        config_.token = env_tok;
    }

    const char* env_enable = std::getenv("NOC_ENABLE_HTTP_TRANSPORT");
    if (env_enable) {
        std::string s(env_enable);
        config_.enabled = (s == "1" || s == "true" || s == "TRUE" || s == "yes");
    }

    const char* env_insecure = std::getenv("NOC_ALLOW_INSECURE_HTTP");
    if (env_insecure) {
        std::string s(env_insecure);
        config_.allow_insecure_http = (s == "1" || s == "true" || s == "TRUE");
    }

    // Валидация протокола
    if (!config_.server_url.empty()) {
        if (config_.server_url.rfind("http://", 0) == 0 && !config_.allow_insecure_http) {
            out_error = "Insecure HTTP scheme is prohibited by policy. Use HTTPS or set allow_insecure_http=true.";
            Log(LogLevel::ERROR_LVL, out_error);
            return false;
        }
    }

    Log(LogLevel::INFO_LVL, "TransportConfig loaded: server_url=" + 
        (config_.server_url.empty() ? "(none)" : config_.server_url) + 
        ", token=" + MaskTokenForLog(config_.token) + 
        ", enabled=" + (config_.enabled ? "true" : "false (disabled by default)"));

    return true;
}

void TransportManager::SetConfig(const TransportConfig& config) {
    std::lock_guard<std::mutex> lock(mutex_);
    bool significant_change = (config_.server_url != config.server_url) ||
                              (config_.token != config.token) ||
                              (config_.allow_insecure_http != config.allow_insecure_http) ||
                              (config_.enabled != config.enabled);
    config_ = config;
    if (significant_change) {
        backoff_until_ = std::chrono::steady_clock::time_point{};
    }
}

TransportConfig TransportManager::GetConfig() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return config_;
}

void TransportManager::ResetBackoff() {
    std::lock_guard<std::mutex> lock(mutex_);
    backoff_until_ = std::chrono::steady_clock::time_point{};
}

int TransportManager::CalculateBackoffSeconds(int retry_count, int retry_after_header) {
    if (retry_after_header > 0) {
        return std::clamp(retry_after_header, 5, 600);
    }
    int shift = std::min(retry_count, 6);
    int backoff = (1 << shift) * 5; // 5s, 10s, 20s, 40s, 80s, 160s, 320s
    return std::min(backoff, 300);
}

bool TransportManager::IsInBackoff() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return std::chrono::steady_clock::now() < backoff_until_;
}

int TransportManager::GetRemainingBackoffSeconds() const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto now = std::chrono::steady_clock::now();
    if (now >= backoff_until_) return 0;
    return static_cast<int>(std::chrono::duration_cast<std::chrono::seconds>(backoff_until_ - now).count());
}

size_t TransportManager::ProcessPendingBatch(std::string& out_error) {
    TransportConfig cfg;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        cfg = config_;
        if (!cfg.enabled) {
            return 0; // Транспорт выключен по умолчанию
        }
        if (std::chrono::steady_clock::now() < backoff_until_) {
            return 0; // Находимся в периоде backoff
        }
    }

    if (cfg.server_url.empty()) {
        out_error = "Server URL is not configured";
        return 0;
    }

    // Формирование полного URL эндпоинта Ingestion API
    std::string endpoint_url = cfg.server_url;
    if (endpoint_url.back() == '/') {
        endpoint_url.pop_back();
    }
    if (endpoint_url.rfind("/api/v1/telemetry") == std::string::npos) {
        endpoint_url += "/api/v1/telemetry";
    }

    // Проверка HTTPS
    if (endpoint_url.rfind("http://", 0) == 0 && !cfg.allow_insecure_http) {
        out_error = "Refusing to transmit telemetry over plain HTTP: HTTPS required";
        Log(LogLevel::ERROR_LVL, out_error);
        std::lock_guard<std::mutex> lock(mutex_);
        backoff_until_ = std::chrono::steady_clock::now() + std::chrono::seconds(60);
        return 0;
    }

    // Извлечение пачки ожидающих событий (до 10 записей за итерацию)
    std::vector<QueueRecord> batch;
    std::string q_err;
    if (!queue_.GetPending(10, batch, q_err)) {
        out_error = "Failed to query pending records: " + q_err;
        return 0;
    }

    if (batch.empty()) {
        return 0;
    }

    size_t sent_count = 0;

    for (const auto& record : batch) {
        if (stop_requested_.load()) {
            break;
        }

        // Парсинг конверта Spool для преобразования в Ingestion API
        SpoolEnvelope env;
        std::string parse_err;
        if (!json::Parser::ParseSpoolEnvelope(record.raw_envelope, env, parse_err)) {
            Log(LogLevel::WARN_LVL, "Poison record in queue id=" + std::to_string(record.id) + 
                                    ": " + parse_err + ". Marking FAILED.");
            queue_.UpdateStatus(record.id, "FAILED", q_err);
            continue;
        }

        std::string payload_json = EnvelopeToIngestionPayload(env, cfg.remote_type, cfg.remote_id);

        // Отправка через абстрактный HTTP-клиент
        HttpResponse resp = client_->Post(
            endpoint_url,
            cfg.token,
            payload_json,
            cfg.send_timeout_ms
        );

        if (stop_requested_.load()) {
            break;
        }

        // Анализ ответа сервера
        if (resp.status_code == 200) {
            // Проверка подтверждения "success": true в JSON ответе
            json::Value resp_val;
            std::string json_err;
            bool success_confirmed = false;
            if (json::Parser::Parse(resp.body, resp_val, json_err) && resp_val.IsObject()) {
                if (const auto* s = resp_val.Find("success")) {
                    if (s->IsBool() && s->AsBool()) {
                        success_confirmed = true;
                    }
                }
            }

            if (success_confirmed) {
                // Подтверждено сервером -> помечаем SENT в локальной очереди SQLite
                queue_.UpdateStatus(record.id, "SENT", q_err);
                sent_count++;
                Log(LogLevel::INFO_LVL, "Delivered event id=" + std::to_string(record.id) + 
                                        " [" + record.priority + "] (" + record.event_id + ")");
            } else {
                Log(LogLevel::WARN_LVL, "Server HTTP 200 without success confirmation for id=" + 
                                        std::to_string(record.id) + ": " + resp.body);
                queue_.IncrementRetry(record.id, q_err);
            }

        } else if (resp.status_code == 401 || resp.status_code == 403) {
            // Ошибка авторизации: токен не принят сервером
            Log(LogLevel::ERROR_LVL, "Authentication failed (HTTP " + std::to_string(resp.status_code) + 
                                    ") for event id=" + std::to_string(record.id) + 
                                    ". Please check configured NOC_TOKEN. Event remains in queue.");
            queue_.IncrementRetry(record.id, q_err);
            // Устанавливаем бэкофф на 60 секунд, чтобы не спамить сервер
            std::lock_guard<std::mutex> lock(mutex_);
            backoff_until_ = std::chrono::steady_clock::now() + std::chrono::seconds(60);
            break;

        } else if (resp.status_code == 429) {
            // Rate limiting (ограничение частоты)
            int backoff_sec = CalculateBackoffSeconds(record.retry_count, resp.retry_after_seconds);
            Log(LogLevel::WARN_LVL, "Rate limited (HTTP 429). Server requested Retry-After=" + 
                                    std::to_string(resp.retry_after_seconds) + "s. Backing off for " + 
                                    std::to_string(backoff_sec) + "s.");
            queue_.IncrementRetry(record.id, q_err);
            std::lock_guard<std::mutex> lock(mutex_);
            backoff_until_ = std::chrono::steady_clock::now() + std::chrono::seconds(backoff_sec);
            break;

        } else if (resp.status_code == 400 || resp.status_code == 413 || resp.status_code == 422) {
            // Ошибка формата пакета на стороне сервера
            Log(LogLevel::ERROR_LVL, "Server rejected payload (HTTP " + std::to_string(resp.status_code) + 
                                    ") for event id=" + std::to_string(record.id) + ": " + resp.body);
            if (record.retry_count >= cfg.max_retries) {
                Log(LogLevel::WARN_LVL, "Event id=" + std::to_string(record.id) + 
                                        " exceeded max retries. Marking FAILED.");
                queue_.UpdateStatus(record.id, "FAILED", q_err);
            } else {
                queue_.IncrementRetry(record.id, q_err);
            }

        } else {
            // 5xx серверная ошибка или сетевой сбой / таймаут
            int backoff_sec = CalculateBackoffSeconds(record.retry_count);
            std::string err_desc = resp.network_error ? resp.error_message : ("HTTP " + std::to_string(resp.status_code));
            Log(LogLevel::WARN_LVL, "Network/server error transmitting event id=" + std::to_string(record.id) + 
                                    ": " + err_desc + ". Retry count=" + std::to_string(record.retry_count + 1) + 
                                    ". Backoff=" + std::to_string(backoff_sec) + "s.");
            queue_.IncrementRetry(record.id, q_err);
            std::lock_guard<std::mutex> lock(mutex_);
            backoff_until_ = std::chrono::steady_clock::now() + std::chrono::seconds(backoff_sec);
            break;
        }
    }

    return sent_count;
}

void TransportManager::Start() {
    if (is_running_.load()) return;

    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!config_.enabled) {
            Log(LogLevel::INFO_LVL, "WinHTTP transport is disabled by default (Phase 4.3 Safe Rollout). "
                                    "Set enable_http_transport=true in config.json or NOC_ENABLE_HTTP_TRANSPORT=1 to activate.");
            return;
        }
    }

    is_running_.store(true);
    stop_requested_.store(false);
    worker_thread_ = std::thread(&TransportManager::WorkerLoop, this);
}

void TransportManager::Stop() {
    if (!is_running_.load()) return;
    stop_requested_.store(true);

    if (client_) {
        client_->Abort();
    }

    if (worker_thread_.joinable()) {
        if (worker_thread_.get_id() != std::this_thread::get_id()) {
            worker_thread_.join();
        }
    }
    is_running_.store(false);
}

void TransportManager::WorkerLoop() {
    Log(LogLevel::INFO_LVL, "TransportManager worker thread started.");

    while (!stop_requested_.load()) {
        std::string err;
        ProcessPendingBatch(err);

        uint32_t interval_ms = 10000;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            interval_ms = config_.poll_interval_ms;
        }

        // Сон с частой проверкой флага завершения
        uint32_t steps = std::max<uint32_t>(1, interval_ms / 200);
        for (uint32_t i = 0; i < steps; ++i) {
            if (stop_requested_.load()) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
    }

    Log(LogLevel::INFO_LVL, "TransportManager worker thread terminated cleanly.");
}

} // namespace noc::transport
