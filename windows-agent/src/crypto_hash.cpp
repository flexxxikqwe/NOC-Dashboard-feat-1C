#include "crypto_hash.hpp"
#include <iomanip>
#include <sstream>
#include <cstring>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <bcrypt.h>
#pragma comment(lib, "bcrypt.lib")

namespace noc::crypto {

namespace {

static thread_local uint32_t t_last_crypto_status = 0;

inline void SetLastCryptoStatus(uint32_t status) {
    t_last_crypto_status = status;
}

// RAII обертка для дескриптора крипто-провайдера BCrypt
struct ScopedBcryptAlg {
    BCRYPT_ALG_HANDLE handle = nullptr;
    ~ScopedBcryptAlg() {
        if (handle) {
            ::BCryptCloseAlgorithmProvider(handle, 0);
            handle = nullptr;
        }
    }
    ScopedBcryptAlg(const ScopedBcryptAlg&) = delete;
    ScopedBcryptAlg& operator=(const ScopedBcryptAlg&) = delete;
    ScopedBcryptAlg() = default;
};

// RAII обертка для дескриптора хеша BCrypt
struct ScopedBcryptHash {
    BCRYPT_HASH_HANDLE handle = nullptr;
    ~ScopedBcryptHash() {
        if (handle) {
            ::BCryptDestroyHash(handle);
            handle = nullptr;
        }
    }
    ScopedBcryptHash(const ScopedBcryptHash&) = delete;
    ScopedBcryptHash& operator=(const ScopedBcryptHash&) = delete;
    ScopedBcryptHash() = default;
};

static const char kHexDigits[] = "0123456789abcdef";

inline std::string BytesToHex64(const uint8_t bytes[32]) {
    std::string hex(64, '0');
    for (size_t i = 0; i < 32; ++i) {
        hex[i * 2]     = kHexDigits[(bytes[i] >> 4) & 0x0F];
        hex[i * 2 + 1] = kHexDigits[bytes[i] & 0x0F];
    }
    return hex;
}

} // anonymous namespace

uint32_t GetLastCryptoStatus() {
    return t_last_crypto_status;
}

std::string ComputeSha256(const void* data, size_t size) {
    SetLastCryptoStatus(0);

    ScopedBcryptAlg alg;
    BCRYPT_ALG_HANDLE h_alg = nullptr;
    NTSTATUS status = ::BCryptOpenAlgorithmProvider(
        &h_alg,
        BCRYPT_SHA256_ALGORITHM,
        nullptr,
        0
    );

    if (!BCRYPT_SUCCESS(status) || !h_alg) {
        SetLastCryptoStatus(static_cast<uint32_t>(status));
        return "";
    }
    alg.handle = h_alg;

    // Запрос требуемого размера hash object для полной совместимости с Windows 7 / POSReady 7
    DWORD hash_obj_size = 0;
    DWORD data_len = 0;
    status = ::BCryptGetProperty(
        alg.handle,
        BCRYPT_OBJECT_LENGTH,
        reinterpret_cast<PUCHAR>(&hash_obj_size),
        sizeof(hash_obj_size),
        &data_len,
        0
    );

    if (!BCRYPT_SUCCESS(status) || hash_obj_size == 0) {
        SetLastCryptoStatus(static_cast<uint32_t>(status));
        return "";
    }

    std::vector<uint8_t> hash_object(hash_obj_size, 0);

    ScopedBcryptHash hash;
    BCRYPT_HASH_HANDLE h_hash = nullptr;
    status = ::BCryptCreateHash(
        alg.handle,
        &h_hash,
        hash_object.data(),
        static_cast<ULONG>(hash_object.size()),
        nullptr,
        0,
        0
    );

    if (!BCRYPT_SUCCESS(status) || !h_hash) {
        SetLastCryptoStatus(static_cast<uint32_t>(status));
        return "";
    }
    hash.handle = h_hash;

    // Хеширование данных порциями (защита от переполнения ULONG при очень больших размерах)
    if (size > 0 && data != nullptr) {
        const uint8_t* byte_ptr = static_cast<const uint8_t*>(data);
        size_t remaining = size;
        const size_t kChunkSize = 64 * 1024 * 1024; // 64 MB

        while (remaining > 0) {
            ULONG to_hash = static_cast<ULONG>((remaining > kChunkSize) ? kChunkSize : remaining);
            status = ::BCryptHashData(
                hash.handle,
                reinterpret_cast<PUCHAR>(const_cast<uint8_t*>(byte_ptr)),
                to_hash,
                0
            );

            if (!BCRYPT_SUCCESS(status)) {
                SetLastCryptoStatus(static_cast<uint32_t>(status));
                return "";
            }

            byte_ptr += to_hash;
            remaining -= to_hash;
        }
    } else if (size > 0 && data == nullptr) {
        SetLastCryptoStatus(0xC000000D); // STATUS_INVALID_PARAMETER
        return "";
    }

    uint8_t hash_bytes[32] = {0};
    status = ::BCryptFinishHash(
        hash.handle,
        hash_bytes,
        sizeof(hash_bytes),
        0
    );

    if (!BCRYPT_SUCCESS(status)) {
        SetLastCryptoStatus(static_cast<uint32_t>(status));
        return "";
    }

    SetLastCryptoStatus(0); // STATUS_SUCCESS
    return BytesToHex64(hash_bytes);
}

std::string ComputeSha256(const std::string& data) {
    return ComputeSha256(data.data(), data.size());
}

} // namespace noc::crypto

#else

// ============================================================================
// POSIX / Non-Windows Fallback (FIPS 180-4 reference implementation)
// Используется для модульных тестов и CI в Linux/macOS средах
// ============================================================================

namespace noc::crypto {

namespace {

inline uint32_t RotR(uint32_t x, uint32_t n) {
    return (x >> n) | (x << (32 - n));
}

inline uint32_t Choose(uint32_t e, uint32_t f, uint32_t g) {
    return (e & f) ^ (~e & g);
}

inline uint32_t Majority(uint32_t a, uint32_t b, uint32_t c) {
    return (a & b) ^ (a & c) ^ (b & c);
}

inline uint32_t Sigma0(uint32_t x) {
    return RotR(x, 2) ^ RotR(x, 13) ^ RotR(x, 22);
}

inline uint32_t Sigma1(uint32_t x) {
    return RotR(x, 6) ^ RotR(x, 11) ^ RotR(x, 25);
}

inline uint32_t Gamma0(uint32_t x) {
    return RotR(x, 7) ^ RotR(x, 18) ^ (x >> 3);
}

inline uint32_t Gamma1(uint32_t x) {
    return RotR(x, 17) ^ RotR(x, 19) ^ (x >> 10);
}

static const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};

struct Sha256Context {
    uint32_t state[8];
    uint64_t count;
    uint8_t buffer[64];
};

void Sha256Init(Sha256Context* ctx) {
    ctx->state[0] = 0x6a09e667;
    ctx->state[1] = 0xbb67ae85;
    ctx->state[2] = 0x3c6ef372;
    ctx->state[3] = 0xa54ff53a;
    ctx->state[4] = 0x510e527f;
    ctx->state[5] = 0x9b05688c;
    ctx->state[6] = 0x1f83d9ab;
    ctx->state[7] = 0x5be0cd19;
    ctx->count = 0;
}

void Sha256Transform(uint32_t state[8], const uint8_t buffer[64]) {
    uint32_t w[64];
    for (int i = 0; i < 16; ++i) {
        w[i] = (static_cast<uint32_t>(buffer[i * 4]) << 24) |
               (static_cast<uint32_t>(buffer[i * 4 + 1]) << 16) |
               (static_cast<uint32_t>(buffer[i * 4 + 2]) << 8) |
               (static_cast<uint32_t>(buffer[i * 4 + 3]));
    }
    for (int i = 16; i < 64; ++i) {
        w[i] = Gamma1(w[i - 2]) + w[i - 7] + Gamma0(w[i - 15]) + w[i - 16];
    }

    uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
    uint32_t e = state[4], f = state[5], g = state[6], h = state[7];

    for (int i = 0; i < 64; ++i) {
        uint32_t t1 = h + Sigma1(e) + Choose(e, f, g) + K[i] + w[i];
        uint32_t t2 = Sigma0(a) + Majority(a, b, c);
        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }

    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
}

void Sha256Update(Sha256Context* ctx, const uint8_t* data, size_t len) {
    size_t buffer_idx = static_cast<size_t>((ctx->count / 8) % 64);
    ctx->count += len * 8;

    size_t part_len = 64 - buffer_idx;
    size_t i = 0;

    if (len >= part_len) {
        std::memcpy(&ctx->buffer[buffer_idx], data, part_len);
        Sha256Transform(ctx->state, ctx->buffer);
        for (i = part_len; i + 63 < len; i += 64) {
            Sha256Transform(ctx->state, &data[i]);
        }
        buffer_idx = 0;
    }

    if (i < len) {
        std::memcpy(&ctx->buffer[buffer_idx], &data[i], len - i);
    }
}

void Sha256Final(Sha256Context* ctx, uint8_t digest[32]) {
    uint8_t final_count[8];
    for (int i = 0; i < 8; ++i) {
        final_count[i] = static_cast<uint8_t>((ctx->count >> ((7 - i) * 8)) & 0xFF);
    }

    uint8_t pad = 0x80;
    Sha256Update(ctx, &pad, 1);

    uint8_t zero = 0;
    while ((ctx->count / 8) % 64 != 56) {
        Sha256Update(ctx, &zero, 1);
    }

    Sha256Update(ctx, final_count, 8);

    for (int i = 0; i < 8; ++i) {
        digest[i * 4] = static_cast<uint8_t>((ctx->state[i] >> 24) & 0xFF);
        digest[i * 4 + 1] = static_cast<uint8_t>((ctx->state[i] >> 16) & 0xFF);
        digest[i * 4 + 2] = static_cast<uint8_t>((ctx->state[i] >> 8) & 0xFF);
        digest[i * 4 + 3] = static_cast<uint8_t>(ctx->state[i] & 0xFF);
    }
}

static const char kHexDigits[] = "0123456789abcdef";

inline std::string BytesToHex64(const uint8_t bytes[32]) {
    std::string hex(64, '0');
    for (size_t i = 0; i < 32; ++i) {
        hex[i * 2]     = kHexDigits[(bytes[i] >> 4) & 0x0F];
        hex[i * 2 + 1] = kHexDigits[bytes[i] & 0x0F];
    }
    return hex;
}

} // anonymous namespace

uint32_t GetLastCryptoStatus() {
    return 0; // POSIX fallback всегда успешен (код 0)
}

std::string ComputeSha256(const void* data, size_t size) {
    Sha256Context ctx;
    Sha256Init(&ctx);
    if (size > 0 && data != nullptr) {
        Sha256Update(&ctx, static_cast<const uint8_t*>(data), size);
    }

    uint8_t digest[32];
    Sha256Final(&ctx, digest);

    return BytesToHex64(digest);
}

std::string ComputeSha256(const std::string& data) {
    return ComputeSha256(data.data(), data.size());
}

} // namespace noc::crypto

#endif
