#pragma once

#include "common.hpp"
#include <utility>

namespace noc {

#ifdef _WIN32

// RAII обертка для Win32 HANDLE (файлы, события, мьютексы, процессы)
class ScopedHandle {
public:
    explicit ScopedHandle(HANDLE h = INVALID_HANDLE_VALUE) noexcept : handle_(h) {}
    ~ScopedHandle() noexcept {
        Close();
    }

    ScopedHandle(const ScopedHandle&) = delete;
    ScopedHandle& operator=(const ScopedHandle&) = delete;

    ScopedHandle(ScopedHandle&& other) noexcept : handle_(other.handle_) {
        other.handle_ = INVALID_HANDLE_VALUE;
    }

    ScopedHandle& operator=(ScopedHandle&& other) noexcept {
        if (this != &other) {
            Close();
            handle_ = other.handle_;
            other.handle_ = INVALID_HANDLE_VALUE;
        }
        return *this;
    }

    [[nodiscard]] bool IsValid() const noexcept {
        return handle_ != INVALID_HANDLE_VALUE && handle_ != nullptr;
    }

    [[nodiscard]] HANDLE Get() const noexcept {
        return handle_;
    }

    [[nodiscard]] HANDLE* AddressOf() noexcept {
        return &handle_;
    }

    HANDLE Release() noexcept {
        HANDLE temp = handle_;
        handle_ = INVALID_HANDLE_VALUE;
        return temp;
    }

    void Reset(HANDLE h = INVALID_HANDLE_VALUE) noexcept {
        if (handle_ != h) {
            Close();
            handle_ = h;
        }
    }

    void Close() noexcept {
        if (IsValid()) {
            ::CloseHandle(handle_);
            handle_ = INVALID_HANDLE_VALUE;
        }
    }

private:
    HANDLE handle_ = INVALID_HANDLE_VALUE;
};

// RAII обертка для FindFirstFile / FindNextFile
class ScopedFindHandle {
public:
    explicit ScopedFindHandle(HANDLE h = INVALID_HANDLE_VALUE) noexcept : handle_(h) {}
    ~ScopedFindHandle() noexcept {
        Close();
    }

    ScopedFindHandle(const ScopedFindHandle&) = delete;
    ScopedFindHandle& operator=(const ScopedFindHandle&) = delete;

    ScopedFindHandle(ScopedFindHandle&& other) noexcept : handle_(other.handle_) {
        other.handle_ = INVALID_HANDLE_VALUE;
    }

    ScopedFindHandle& operator=(ScopedFindHandle&& other) noexcept {
        if (this != &other) {
            Close();
            handle_ = other.handle_;
            other.handle_ = INVALID_HANDLE_VALUE;
        }
        return *this;
    }

    [[nodiscard]] bool IsValid() const noexcept {
        return handle_ != INVALID_HANDLE_VALUE && handle_ != nullptr;
    }

    [[nodiscard]] HANDLE Get() const noexcept {
        return handle_;
    }

    void Close() noexcept {
        if (IsValid()) {
            ::FindClose(handle_);
            handle_ = INVALID_HANDLE_VALUE;
        }
    }

private:
    HANDLE handle_ = INVALID_HANDLE_VALUE;
};

// RAII обертка для Service Control Manager (SC_HANDLE)
class ScopedServiceHandle {
public:
    explicit ScopedServiceHandle(SC_HANDLE h = nullptr) noexcept : handle_(h) {}
    ~ScopedServiceHandle() noexcept {
        Close();
    }

    ScopedServiceHandle(const ScopedServiceHandle&) = delete;
    ScopedServiceHandle& operator=(const ScopedServiceHandle&) = delete;

    ScopedServiceHandle(ScopedServiceHandle&& other) noexcept : handle_(other.handle_) {
        other.handle_ = nullptr;
    }

    ScopedServiceHandle& operator=(ScopedServiceHandle&& other) noexcept {
        if (this != &other) {
            Close();
            handle_ = other.handle_;
            other.handle_ = nullptr;
        }
        return *this;
    }

    [[nodiscard]] bool IsValid() const noexcept {
        return handle_ != nullptr;
    }

    [[nodiscard]] SC_HANDLE Get() const noexcept {
        return handle_;
    }

    void Close() noexcept {
        if (handle_ != nullptr) {
            ::CloseServiceHandle(handle_);
            handle_ = nullptr;
        }
    }

private:
    SC_HANDLE handle_ = nullptr;
};

// RAII обертка для LocalAlloc памяти
template <typename T>
class ScopedLocalMem {
public:
    explicit ScopedLocalMem(T* ptr = nullptr) noexcept : ptr_(ptr) {}
    ~ScopedLocalMem() noexcept {
        Reset();
    }

    ScopedLocalMem(const ScopedLocalMem&) = delete;
    ScopedLocalMem& operator=(const ScopedLocalMem&) = delete;

    ScopedLocalMem(ScopedLocalMem&& other) noexcept : ptr_(other.ptr_) {
        other.ptr_ = nullptr;
    }

    ScopedLocalMem& operator=(ScopedLocalMem&& other) noexcept {
        if (this != &other) {
            Reset();
            ptr_ = other.ptr_;
            other.ptr_ = nullptr;
        }
        return *this;
    }

    [[nodiscard]] T* Get() const noexcept {
        return ptr_;
    }

    T** AddressOf() noexcept {
        return &ptr_;
    }

    void Reset(T* ptr = nullptr) noexcept {
        if (ptr_ != nullptr) {
            ::LocalFree(reinterpret_cast<HLOCAL>(ptr_));
            ptr_ = nullptr;
        }
        ptr_ = ptr;
    }

private:
    T* ptr_ = nullptr;
};

#else

// POSIX fallback заглушка для сборки и кросс-компиляции модульных тестов
class ScopedHandle {
public:
    explicit ScopedHandle(int fd = -1) noexcept : fd_(fd) {}
    ~ScopedHandle() noexcept { Close(); }
    ScopedHandle(const ScopedHandle&) = delete;
    ScopedHandle& operator=(const ScopedHandle&) = delete;
    ScopedHandle(ScopedHandle&& o) noexcept : fd_(o.fd_) { o.fd_ = -1; }
    ScopedHandle& operator=(ScopedHandle&& o) noexcept {
        if (this != &o) { Close(); fd_ = o.fd_; o.fd_ = -1; }
        return *this;
    }
    [[nodiscard]] bool IsValid() const noexcept { return fd_ >= 0; }
    [[nodiscard]] int Get() const noexcept { return fd_; }
    void Close() noexcept {
        if (fd_ >= 0) {
            // close(fd_);
            fd_ = -1;
        }
    }
private:
    int fd_ = -1;
};

#endif

} // namespace noc
