#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <memory>
#include <chrono>
#include <iostream>
#include <sstream>
#include <iomanip>

#ifdef _WIN32
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #ifndef NOMINMAX
    #define NOMINMAX
  #endif
  #include <windows.h>
#endif

namespace noc {

// ============================================================================
// Константы контракта 1C-NOC (SPOOL_CONTRACT.md v1.0)
// ============================================================================

// Версия протокола конверта
inline constexpr const char* SCHEMA_VERSION_1_0 = "1.0";
inline constexpr const char* SOURCE_1C_EXTENSION = "1C_EXTENSION";

// Имя службы Windows
inline constexpr const wchar_t* SERVICE_NAME = L"1C-NOC-Agent";
inline constexpr const wchar_t* SERVICE_DISPLAY_NAME = L"1C-NOC Telemetry & Spool Agent";
inline constexpr const wchar_t* SERVICE_DESCRIPTION = 
    L"Агент сбора телеметрии касс 1С:Предприятие, локальной очереди spool и передачи метрик.";

// Ограничения размеров и квот
inline constexpr size_t MAX_PAYLOAD_BYTES = 65536;               // 64 КБ (строгий лимит диска/API)
inline constexpr size_t WARNING_PAYLOAD_BYTES = 55000;           // 55 КБ (порог усечения в 1С)
inline constexpr size_t MAX_SPOOL_FILES = 50;                    // Лимит очереди файлов на диске
inline constexpr size_t TELEMETRY_QUOTA = 40;                    // Квота рутинной телеметрии (80%)
inline constexpr size_t EMERGENCY_RESERVED_SLOTS = 10;           // Резерв для инцидентов (файлы 41-50)
inline constexpr int64_t TMP_CLEANUP_AGE_SECONDS = 300;          // Очистка .tmp старше 5 минут (300 с)
inline constexpr int64_t SQLITE_QUEUE_MAX_BYTES = 10 * 1024 * 1024; // 10 МБ лимит локальной SQLite базы

// Интервалы работы
inline constexpr uint32_t FALLBACK_POLL_INTERVAL_MS = 5000;      // 5 секунд резервный опрос каталога
inline constexpr uint32_t TMP_SWEEP_INTERVAL_MS = 60000;         // Раз в 60 секунд проверка старых .tmp

// Пути по умолчанию (Windows ProgramData)
inline constexpr const char* DEFAULT_BASE_DIR = "C:\\ProgramData\\1C-NOC";
inline constexpr const char* DEFAULT_SPOOL_DIR = "C:\\ProgramData\\1C-NOC\\spool";
inline constexpr const char* DEFAULT_QUARANTINE_DIR = "C:\\ProgramData\\1C-NOC\\quarantine";
inline constexpr const char* DEFAULT_DB_PATH = "C:\\ProgramData\\1C-NOC\\queue.db";
inline constexpr const char* DEFAULT_CONFIG_PATH = "C:\\ProgramData\\1C-NOC\\config.json";

// Переменные окружения для переопределения (юнит-тесты и стенды)
inline constexpr const char* ENV_SPOOL_DIR = "NOC_SPOOL_DIR";
inline constexpr const char* ENV_QUARANTINE_DIR = "NOC_QUARANTINE_DIR";
inline constexpr const char* ENV_DB_PATH = "NOC_DB_PATH";
inline constexpr const char* ENV_CONFIG_PATH = "NOC_CONFIG_PATH";

// ============================================================================
// Приоритеты и типы событий
// ============================================================================

enum class Priority {
    LOW = 0,
    NORMAL = 1,
    HIGH = 2
};

inline const char* PriorityToString(Priority p) {
    switch (p) {
        case Priority::HIGH: return "HIGH";
        case Priority::LOW: return "LOW";
        case Priority::NORMAL:
        default: return "NORMAL";
    }
}

inline Priority PriorityFromString(const std::string& str) {
    if (str == "HIGH") return Priority::HIGH;
    if (str == "LOW") return Priority::LOW;
    return Priority::NORMAL;
}

enum class EventType {
    TELEMETRY,
    INCIDENT,
    HEARTBEAT,
    UNKNOWN
};

inline const char* EventTypeToString(EventType t) {
    switch (t) {
        case EventType::TELEMETRY: return "TELEMETRY";
        case EventType::INCIDENT: return "INCIDENT";
        case EventType::HEARTBEAT: return "HEARTBEAT";
        default: return "UNKNOWN";
    }
}

inline EventType EventTypeFromString(const std::string& str) {
    if (str == "TELEMETRY") return EventType::TELEMETRY;
    if (str == "INCIDENT") return EventType::INCIDENT;
    if (str == "HEARTBEAT") return EventType::HEARTBEAT;
    return EventType::UNKNOWN;
}

// ============================================================================
// Структура полезной нагрузки и конверта
// ============================================================================

struct OneCInfo {
    std::string platform_version;
    std::string configuration_name;
    std::string computer_name;
};

struct SpoolEnvelope {
    std::string schema_version;
    std::string event_id;
    std::string timestamp_utc;
    std::string source;
    std::string event_type;
    std::string priority;
    
    // Payload fields
    std::string shop;
    std::string workplace;
    std::vector<std::string> warnings;
    std::string runtime_errors_raw_json;
    std::string health_checks_raw_json;
    OneCInfo one_c_info;
    
    // Исходный сырой JSON пакета
    std::string raw_json;
    // Вычисленный SHA-256
    std::string sha256_hash;
    // Исходное имя файла на диске
    std::string source_filename;
};

// Элемент очереди SQLite
struct QueueRecord {
    int64_t id = 0;
    std::string event_id;
    std::string timestamp_utc;
    std::string sha256_hash;
    std::string event_type;
    std::string priority;
    std::string raw_envelope;
    std::string status; // "PENDING", "PROCESSING", "SENT", "FAILED"
    int retry_count = 0;
    int64_t created_at_unix = 0;
};

// ============================================================================
// Логирование
// ============================================================================

enum class LogLevel {
    DEBUG_LVL,
    INFO_LVL,
    WARN_LVL,
    ERROR_LVL
};

inline void Log(LogLevel level, const std::string& message) {
    const char* tag = "INFO";
    switch (level) {
        case LogLevel::DEBUG_LVL: tag = "DEBUG"; break;
        case LogLevel::INFO_LVL:  tag = "INFO";  break;
        case LogLevel::WARN_LVL:  tag = "WARN";  break;
        case LogLevel::ERROR_LVL: tag = "ERROR"; break;
    }
    
    auto now = std::chrono::system_clock::now();
    auto tt = std::chrono::system_clock::to_time_t(now);
    std::tm tm_buf{};
#if defined(_WIN32)
    gmtime_s(&tm_buf, &tt);
#else
    gmtime_r(&tt, &tm_buf);
#endif

    std::ostringstream ss;
    ss << std::put_time(&tm_buf, "%Y-%m-%dT%H:%M:%SZ") << " [" << tag << "] " << message << "\n";
    std::cerr << ss.str();
}

} // namespace noc
