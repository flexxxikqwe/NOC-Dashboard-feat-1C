#pragma once

#include "common.hpp"
#include <string>

namespace noc::service {

// Режимы запуска приложения
enum class RunMode {
    SERVICE,      // Штатный запуск через Windows Service Control Manager
    CONSOLE,      // Интерактивный запуск в терминале (отладка)
    RUN_ONCE,     // Однократный проход по очереди spool и выход
    INSTALL,      // Установка службы в SCM
    UNINSTALL,    // Удаление службы из SCM
    START,        // Запуск службы через SCM
    STOP,         // Остановка службы через SCM
    STATUS,       // Проверка статуса службы
    VERSION       // Вывод версии и платформы
};

class ServiceCore {
public:
    static ServiceCore& Instance();

    // Парсинг аргументов командной строки
    RunMode ParseCommandLine(int argc, char* argv[]);

    // Выполнение соответствующего режима
    int Run(RunMode mode);

#ifdef _WIN32
    // Точка входа для Service Control Manager
    static void WINAPI ServiceMain(DWORD argc, LPWSTR* argv);
    static DWORD WINAPI ServiceCtrlHandler(DWORD control, DWORD event_type, LPVOID event_data, LPVOID context);
#endif

private:
    ServiceCore() = default;
    ~ServiceCore() = default;

    int RunAsService();
    int RunConsole();
    int RunOnce();

    int InstallService();
    int UninstallService();
    int StartServiceInstance();
    int StopServiceInstance();
    int QueryServiceState();

#ifdef _WIN32
    void SetStatus(DWORD state, DWORD exit_code = NO_ERROR, DWORD wait_hint = 0);

    SERVICE_STATUS_HANDLE status_handle_ = nullptr;
    SERVICE_STATUS status_{};
    HANDLE stop_event_ = nullptr;
#endif
};

} // namespace noc::service
