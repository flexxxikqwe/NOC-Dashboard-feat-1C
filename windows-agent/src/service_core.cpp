#include "service_core.hpp"
#include "sqlite_queue.hpp"
#include "spool_watcher.hpp"
#include "winhttp_transport.hpp"
#include <csignal>
#include <cstdlib>

#ifdef _WIN32
  #include <shellapi.h>
#endif

namespace noc::service {

static std::atomic<bool> g_console_stop{false};

static void SignalHandler(int signum) {
    if (signum == SIGINT || signum == SIGTERM) {
        g_console_stop.store(true);
        Log(LogLevel::INFO_LVL, "Termination signal received, stopping...");
    }
}

ServiceCore& ServiceCore::Instance() {
    static ServiceCore instance;
    return instance;
}

RunMode ServiceCore::ParseCommandLine(int argc, char* argv[]) {
    if (argc < 2) {
#ifdef _WIN32
        // По умолчанию без аргументов запускается как служба Windows
        return RunMode::SERVICE;
#else
        return RunMode::CONSOLE;
#endif
    }

    std::string arg = argv[1];
    if (arg == "--install" || arg == "-i") return RunMode::INSTALL;
    if (arg == "--uninstall" || arg == "-u") return RunMode::UNINSTALL;
    if (arg == "--start") return RunMode::START;
    if (arg == "--stop") return RunMode::STOP;
    if (arg == "--status") return RunMode::STATUS;
    if (arg == "--console" || arg == "-c") return RunMode::CONSOLE;
    if (arg == "--run-once" || arg == "-1") return RunMode::RUN_ONCE;
    if (arg == "--version" || arg == "-v") return RunMode::VERSION;

    return RunMode::CONSOLE;
}

int ServiceCore::Run(RunMode mode) {
    switch (mode) {
        case RunMode::SERVICE: return RunAsService();
        case RunMode::CONSOLE: return RunConsole();
        case RunMode::RUN_ONCE: return RunOnce();
        case RunMode::INSTALL: return InstallService();
        case RunMode::UNINSTALL: return UninstallService();
        case RunMode::START: return StartServiceInstance();
        case RunMode::STOP: return StopServiceInstance();
        case RunMode::STATUS: return QueryServiceState();
        case RunMode::VERSION:
            std::cout << "1C-NOC Windows Agent v1.0.0 (Native C++17 / Win32)\n"
                      << "Spool Contract Version: 1.0\n"
                      << "Architecture: " 
#if defined(__x86_64__) || defined(_M_X64)
                      << "x86_64 (64-bit)\n";
#elif defined(__i386__) || defined(_M_IX86)
                      << "i686 (32-bit)\n";
#else
                      << "Unknown\n";
#endif
            return 0;
    }
    return 0;
}

int ServiceCore::RunOnce() {
    Log(LogLevel::INFO_LVL, "Executing Run-Once spool pass...");

    const char* env_spool = std::getenv(ENV_SPOOL_DIR);
    const char* env_quar = std::getenv(ENV_QUARANTINE_DIR);
    const char* env_db = std::getenv(ENV_DB_PATH);

    std::string spool_dir = env_spool ? env_spool : DEFAULT_SPOOL_DIR;
    std::string quar_dir = env_quar ? env_quar : DEFAULT_QUARANTINE_DIR;
    std::string db_path = env_db ? env_db : DEFAULT_DB_PATH;

    db::SqliteQueue queue;
    std::string err;
    if (!queue.Open(db_path, err)) {
        Log(LogLevel::ERROR_LVL, "Failed to open SQLite database: " + err);
        return 1;
    }

    spool::SpoolWatcher watcher(spool_dir, quar_dir, queue);
    if (!watcher.Initialize(err)) {
        Log(LogLevel::ERROR_LVL, "Failed to initialize directories: " + err);
        return 1;
    }

    // Очистка зависших .tmp
    size_t swept = watcher.SweepStaleTmpFiles();
    Log(LogLevel::INFO_LVL, "Stale .tmp files swept: " + std::to_string(swept));

    // Проход по очереди spool
    size_t processed = watcher.ProcessOnce(err);
    Log(LogLevel::INFO_LVL, "Spool files processed: " + std::to_string(processed));

    // Проход по очереди транспорта (если включен в конфигурации)
    noc::transport::TransportManager transport(queue);
    std::string cfg_err;
    const char* env_cfg = std::getenv(ENV_CONFIG_PATH);
    std::string cfg_path = env_cfg ? env_cfg : DEFAULT_CONFIG_PATH;
    transport.LoadConfig(cfg_path, cfg_err);
    if (transport.GetConfig().enabled) {
        std::string trans_err;
        size_t sent = transport.ProcessPendingBatch(trans_err);
        Log(LogLevel::INFO_LVL, "Transport batch processed: " + std::to_string(sent) + " sent");
    }

    size_t count = 0;
    int64_t bytes = 0;
    queue.GetStats(count, bytes, err);
    Log(LogLevel::INFO_LVL, "Database stats: " + std::to_string(count) + " records, " + 
                            std::to_string(bytes) + " bytes");

    return 0;
}

int ServiceCore::RunConsole() {
    Log(LogLevel::INFO_LVL, "Starting 1C-NOC Agent in interactive console mode...");

    std::signal(SIGINT, SignalHandler);
    std::signal(SIGTERM, SignalHandler);

    const char* env_spool = std::getenv(ENV_SPOOL_DIR);
    const char* env_quar = std::getenv(ENV_QUARANTINE_DIR);
    const char* env_db = std::getenv(ENV_DB_PATH);
    const char* env_cfg = std::getenv(ENV_CONFIG_PATH);

    std::string spool_dir = env_spool ? env_spool : DEFAULT_SPOOL_DIR;
    std::string quar_dir = env_quar ? env_quar : DEFAULT_QUARANTINE_DIR;
    std::string db_path = env_db ? env_db : DEFAULT_DB_PATH;
    std::string cfg_path = env_cfg ? env_cfg : DEFAULT_CONFIG_PATH;

    db::SqliteQueue queue;
    std::string err;
    if (!queue.Open(db_path, err)) {
        Log(LogLevel::ERROR_LVL, "Failed to open SQLite database: " + err);
        return 1;
    }

    spool::SpoolWatcher watcher(spool_dir, quar_dir, queue);
    if (!watcher.Initialize(err)) {
        Log(LogLevel::ERROR_LVL, "Failed to initialize directories: " + err);
        return 1;
    }

    noc::transport::TransportManager transport(queue);
    std::string cfg_err;
    transport.LoadConfig(cfg_path, cfg_err);

    watcher.Start();
    transport.Start(); // Безопасно: запустит рабочий поток только если config.enabled == true

    Log(LogLevel::INFO_LVL, "Agent is active. Press Ctrl+C to terminate.");

    while (!g_console_stop.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }

    Log(LogLevel::INFO_LVL, "Stopping TransportManager and SpoolWatcher...");
    transport.Stop();
    watcher.Stop();
    queue.Close();
    Log(LogLevel::INFO_LVL, "Agent terminated cleanly.");
    return 0;
}

#ifdef _WIN32

void ServiceCore::SetStatus(DWORD state, DWORD exit_code, DWORD wait_hint) {
    status_.dwCurrentState = state;
    status_.dwWin32ExitCode = exit_code;
    status_.dwWaitHint = wait_hint;

    if (state == SERVICE_START_PENDING) {
        status_.dwControlsAccepted = 0;
    } else {
        status_.dwControlsAccepted = SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN;
    }

    if (state == SERVICE_RUNNING || state == SERVICE_STOPPED) {
        status_.dwCheckPoint = 0;
    } else {
        status_.dwCheckPoint++;
    }

    ::SetServiceStatus(status_handle_, &status_);
}

void WINAPI ServiceCore::ServiceMain(DWORD argc, LPWSTR* argv) {
    auto& self = Instance();
    self.status_handle_ = RegisterServiceCtrlHandlerExW(
        SERVICE_NAME, 
        ServiceCtrlHandler, 
        &self
    );

    if (!self.status_handle_) {
        return;
    }

    self.status_.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    self.SetStatus(SERVICE_START_PENDING, NO_ERROR, 3000);

    self.stop_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!self.stop_event_) {
        self.SetStatus(SERVICE_STOPPED, GetLastError());
        return;
    }

    // Инициализация базы данных и SpoolWatcher
    db::SqliteQueue queue;
    std::string err;
    if (!queue.Open(DEFAULT_DB_PATH, err)) {
        Log(LogLevel::ERROR_LVL, "Service failed to open SQLite database: " + err);
        self.SetStatus(SERVICE_STOPPED, ERROR_CAN_NOT_COMPLETE);
        return;
    }

    spool::SpoolWatcher watcher(DEFAULT_SPOOL_DIR, DEFAULT_QUARANTINE_DIR, queue);
    if (!watcher.Initialize(err)) {
        Log(LogLevel::ERROR_LVL, "Service failed to initialize directories: " + err);
        self.SetStatus(SERVICE_STOPPED, ERROR_CAN_NOT_COMPLETE);
        return;
    }

    noc::transport::TransportManager transport(queue);
    std::string cfg_err;
    transport.LoadConfig(DEFAULT_CONFIG_PATH, cfg_err);

    watcher.Start();
    transport.Start(); // Безопасно: запустит рабочий поток только если config.enabled == true
    self.SetStatus(SERVICE_RUNNING);

    // Ожидание сигнала остановки службы
    WaitForSingleObject(self.stop_event_, INFINITE);

    self.SetStatus(SERVICE_STOP_PENDING, NO_ERROR, 5000);
    transport.Stop();
    watcher.Stop();
    queue.Close();
    CloseHandle(self.stop_event_);

    self.SetStatus(SERVICE_STOPPED);
}

DWORD WINAPI ServiceCore::ServiceCtrlHandler(DWORD control, DWORD, LPVOID, LPVOID context) {
    auto* self = static_cast<ServiceCore*>(context);
    switch (control) {
        case SERVICE_CONTROL_STOP:
        case SERVICE_CONTROL_SHUTDOWN:
            if (self) {
                self->SetStatus(SERVICE_STOP_PENDING, NO_ERROR, 5000);
                SetEvent(self->stop_event_);
            }
            return NO_ERROR;
        case SERVICE_CONTROL_INTERROGATE:
            return NO_ERROR;
        default:
            return ERROR_CALL_NOT_IMPLEMENTED;
    }
}

int ServiceCore::RunAsService() {
    SERVICE_TABLE_ENTRYW service_table[] = {
        { const_cast<LPWSTR>(SERVICE_NAME), ServiceMain },
        { nullptr, nullptr }
    };

    if (!StartServiceCtrlDispatcherW(service_table)) {
        DWORD err = GetLastError();
        if (err == ERROR_FAILED_SERVICE_CONTROLLER_CONNECT) {
            // Запуск из консоли без флагов -> запускаем интерактивно
            return RunConsole();
        }
        return static_cast<int>(err);
    }
    return 0;
}

int ServiceCore::InstallService() {
    wchar_t path[MAX_PATH];
    if (GetModuleFileNameW(nullptr, path, MAX_PATH) == 0) {
        std::cerr << "GetModuleFileNameW failed\n";
        return 1;
    }

    SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CREATE_SERVICE);
    if (!scm) {
        std::cerr << "OpenSCManagerW failed (error " << GetLastError() << "). Run as Administrator.\n";
        return 1;
    }

    SC_HANDLE svc = CreateServiceW(
        scm,
        SERVICE_NAME,
        SERVICE_DISPLAY_NAME,
        SERVICE_ALL_ACCESS,
        SERVICE_WIN32_OWN_PROCESS,
        SERVICE_AUTO_START,
        SERVICE_ERROR_NORMAL,
        path,
        nullptr, nullptr, nullptr, nullptr, nullptr
    );

    if (!svc) {
        DWORD err = GetLastError();
        CloseServiceHandle(scm);
        if (err == ERROR_SERVICE_EXISTS) {
            std::cout << "Service is already installed.\n";
            return 0;
        }
        std::cerr << "CreateServiceW failed with error " << err << "\n";
        return 1;
    }

    SERVICE_DESCRIPTIONW desc;
    desc.lpDescription = const_cast<LPWSTR>(SERVICE_DESCRIPTION);
    ChangeServiceConfig2W(svc, SERVICE_CONFIG_DESCRIPTION, &desc);

    CloseServiceHandle(svc);
    CloseServiceHandle(scm);

    std::cout << "Service '" << noc::SERVICE_NAME << "' successfully installed!\n";
    return 0;
}

int ServiceCore::UninstallService() {
    SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_ALL_ACCESS);
    if (!scm) {
        std::cerr << "OpenSCManagerW failed (error " << GetLastError() << "). Run as Administrator.\n";
        return 1;
    }

    SC_HANDLE svc = OpenServiceW(scm, SERVICE_NAME, SERVICE_STOP | DELETE);
    if (!svc) {
        DWORD err = GetLastError();
        CloseServiceHandle(scm);
        if (err == ERROR_SERVICE_DOES_NOT_EXIST) {
            std::cout << "Service does not exist.\n";
            return 0;
        }
        std::cerr << "OpenServiceW failed with error " << err << "\n";
        return 1;
    }

    SERVICE_STATUS status;
    ControlService(svc, SERVICE_CONTROL_STOP, &status);

    if (!DeleteService(svc)) {
        std::cerr << "DeleteService failed with error " << GetLastError() << "\n";
        CloseServiceHandle(svc);
        CloseServiceHandle(scm);
        return 1;
    }

    CloseServiceHandle(svc);
    CloseServiceHandle(scm);
    std::cout << "Service successfully uninstalled.\n";
    return 0;
}

int ServiceCore::StartServiceInstance() {
    SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!scm) return 1;

    SC_HANDLE svc = OpenServiceW(scm, SERVICE_NAME, SERVICE_START);
    if (!svc) { CloseServiceHandle(scm); return 1; }

    BOOL ok = StartServiceW(svc, 0, nullptr);
    CloseServiceHandle(svc);
    CloseServiceHandle(scm);
    return ok ? 0 : 1;
}

int ServiceCore::StopServiceInstance() {
    SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!scm) return 1;

    SC_HANDLE svc = OpenServiceW(scm, SERVICE_NAME, SERVICE_STOP);
    if (!svc) { CloseServiceHandle(scm); return 1; }

    SERVICE_STATUS st;
    BOOL ok = ControlService(svc, SERVICE_CONTROL_STOP, &st);
    CloseServiceHandle(svc);
    CloseServiceHandle(scm);
    return ok ? 0 : 1;
}

int ServiceCore::QueryServiceState() {
    SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!scm) { std::cout << "Status: Cannot connect to SCM\n"; return 1; }

    SC_HANDLE svc = OpenServiceW(scm, SERVICE_NAME, SERVICE_QUERY_STATUS);
    if (!svc) {
        std::cout << "Status: NOT INSTALLED\n";
        CloseServiceHandle(scm);
        return 0;
    }

    SERVICE_STATUS st;
    if (QueryServiceStatus(svc, &st)) {
        switch (st.dwCurrentState) {
            case SERVICE_RUNNING: std::cout << "Status: RUNNING\n"; break;
            case SERVICE_STOPPED: std::cout << "Status: STOPPED\n"; break;
            case SERVICE_START_PENDING: std::cout << "Status: START_PENDING\n"; break;
            case SERVICE_STOP_PENDING: std::cout << "Status: STOP_PENDING\n"; break;
            default: std::cout << "Status: STATE_" << st.dwCurrentState << "\n"; break;
        }
    }

    CloseServiceHandle(svc);
    CloseServiceHandle(scm);
    return 0;
}

#else

// POSIX заглушки для сборки и модульного тестирования на Linux
int ServiceCore::RunAsService() { return RunConsole(); }
int ServiceCore::InstallService() { std::cout << "Install is a Windows-only operation\n"; return 0; }
int ServiceCore::UninstallService() { std::cout << "Uninstall is a Windows-only operation\n"; return 0; }
int ServiceCore::StartServiceInstance() { return 0; }
int ServiceCore::StopServiceInstance() { return 0; }
int ServiceCore::QueryServiceState() { std::cout << "Status: POSIX_ENV\n"; return 0; }

#endif

} // namespace noc::service
