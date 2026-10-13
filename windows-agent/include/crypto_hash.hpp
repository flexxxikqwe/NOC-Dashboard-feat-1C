#pragma once

#include <string>
#include <cstdint>
#include <cstddef>

namespace noc::crypto {

// Вычисляет SHA-256 хеш данных и возвращает 64-символьную hex-строку
std::string ComputeSha256(const void* data, size_t size);
std::string ComputeSha256(const std::string& data);

} // namespace noc::crypto
