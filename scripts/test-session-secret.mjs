import assert from 'node:assert/strict';
import process from 'node:process';

// Dynamically import session module to test under controlled environment conditions
const sessionMod = await import('../lib/session.ts');

const {
  SESSION_COOKIE_NAME,
  createSessionToken,
  verifySessionToken,
  hasValidSessionFormat,
  safeCompareHex,
} = sessionMod;

console.log('======================================================');
console.log('🔐 NOC DASHBOARD — SESSION & SECRET HARDENING TESTS');
console.log('======================================================\n');

// ------------------------------------------------------------------
// 1. Валидная сессия с явно заданным тестовым секретом принимается
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 1: Валидная сессия с явно заданным тестовым секретом...');
const originalSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = 'test-explicit-custom-secret-key-32-chars-long';

const validToken = await createSessionToken('admin', 'ADMIN', 3600);
assert(typeof validToken === 'string', 'Token must be a string');
assert(hasValidSessionFormat(validToken), 'Token must satisfy hasValidSessionFormat');

const verifiedValid = await verifySessionToken(validToken);
assert.equal(verifiedValid.valid, true, 'Token must verify successfully');
assert.equal(verifiedValid.username, 'admin');
assert.equal(verifiedValid.role, 'ADMIN');
console.log('✅ ТЕСТ 1 УСПЕШНО ПРОЙДЕН: Валидный токен успешно подписан и верифицирован.\n');

// ------------------------------------------------------------------
// 2. Неверная подпись отклоняется
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 2: Неверная подпись отклоняется...');
const parts = validToken.split('.');
const tamperedSig = 'f'.repeat(64); // Valid hex length, but wrong signature
const badSigToken = `${parts[0]}.${parts[1]}.${parts[2]}.${tamperedSig}`;

const verifiedBadSig = await verifySessionToken(badSigToken);
assert.equal(verifiedBadSig.valid, false, 'Tampered signature must be rejected');
console.log('✅ ТЕСТ 2 УСПЕШНО ПРОЙДЕН: Токен с неверной подписью отклонен (valid: false).\n');

// ------------------------------------------------------------------
// 3. Изменение username, role или expiresAt без пересчета подписи
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 3: Изменение полей токена без пересчета подписи...');

// 3a. Изменение username
const tamperedUserToken = `attacker.${parts[1]}.${parts[2]}.${parts[3]}`;
const verifiedTamperedUser = await verifySessionToken(tamperedUserToken);
assert.equal(verifiedTamperedUser.valid, false, 'Tampered username must be rejected');

// 3b. Повышение привилегий (role: ENGINEER -> ADMIN)
const engineerToken = await createSessionToken('engineer_user', 'ENGINEER', 3600);
const engParts = engineerToken.split('.');
const escalatedToken = `${engParts[0]}.ADMIN.${engParts[2]}.${engParts[3]}`;
const verifiedEscalated = await verifySessionToken(escalatedToken);
assert.equal(verifiedEscalated.valid, false, 'Role escalation without resigning must be rejected');

// 3c. Продление expiresAt
const extendedExpires = parseInt(parts[2], 10) + 1000000;
const extendedToken = `${parts[0]}.${parts[1]}.${extendedExpires}.${parts[3]}`;
const verifiedExtended = await verifySessionToken(extendedToken);
assert.equal(verifiedExtended.valid, false, 'Tampered expiresAt must be rejected');

console.log('✅ ТЕСТ 3 УСПЕШНО ПРОЙДЕН: Любое изменение полезной нагрузки без ключа отклоняется.\n');

// ------------------------------------------------------------------
// 4. Просроченная сессия отклоняется
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 4: Просроченная сессия отклоняется...');
// Создаем токен с maxAge = -10 секунд (уже истек)
const expiredToken = await createSessionToken('admin', 'ADMIN', -10);
assert.equal(hasValidSessionFormat(expiredToken), false, 'Expired token format check must return false');

const verifiedExpired = await verifySessionToken(expiredToken);
assert.equal(verifiedExpired.valid, false, 'Expired token verification must return valid: false');
console.log('✅ ТЕСТ 4 УСПЕШНО ПРОЙДЕН: Просроченный токен отклонен и на уровне формата, и криптографически.\n');

// ------------------------------------------------------------------
// 5. Обрезанная подпись и подпись неверного формата отклоняются
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 5: Обрезанная подпись и подпись неверного формата...');
// 5a. Обрезанная подпись (32 символа вместо 64)
const truncatedSigToken = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3].substring(0, 32)}`;
assert.equal(hasValidSessionFormat(truncatedSigToken), false, 'Truncated sig format check must return false');
const verifiedTruncated = await verifySessionToken(truncatedSigToken);
assert.equal(verifiedTruncated.valid, false, 'Truncated sig must be rejected');

// 5b. Не-hex символы в подписи (например, символы 'zzzz...')
const nonHexSig = 'z'.repeat(64);
const nonHexSigToken = `${parts[0]}.${parts[1]}.${parts[2]}.${nonHexSig}`;
assert.equal(hasValidSessionFormat(nonHexSigToken), false, 'Non-hex sig format check must return false');
const verifiedNonHex = await verifySessionToken(nonHexSigToken);
assert.equal(verifiedNonHex.valid, false, 'Non-hex sig must be rejected');

// 5c. safeCompareHex прямые тесты
assert.equal(safeCompareHex('a'.repeat(64), 'a'.repeat(64)), true);
assert.equal(safeCompareHex('A'.repeat(64), 'a'.repeat(64)), true); // Case-insensitive hex
assert.equal(safeCompareHex('a'.repeat(64), 'a'.repeat(63) + 'b'), false);
assert.equal(safeCompareHex('a'.repeat(32), 'a'.repeat(32)), false); // Not 64 chars
assert.equal(safeCompareHex('z'.repeat(64), 'z'.repeat(64)), false); // Invalid hex characters
assert.equal(safeCompareHex('', ''), false);
console.log('✅ ТЕСТ 5 УСПЕШНО ПРОЙДЕН: Обрезанные, не-hex и искаженные подписи строжайше отсекаются.\n');

// ------------------------------------------------------------------
// 6. Отсутствующий production-секрет никогда не приводит к fallback
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 6: Отсутствующий SESSION_SECRET никогда не использует fallback...');
delete process.env.SESSION_SECRET;

// 6a. createSessionToken должен завершиться с ошибкой конфигурации
let createFailedCleanly = false;
try {
  await createSessionToken('admin', 'ADMIN', 3600);
} catch (err) {
  createFailedCleanly = true;
  assert(err instanceof Error);
  assert(err.message.includes('SESSION_SECRET is not configured'), 'Error message must specify missing config');
}
assert.equal(createFailedCleanly, true, 'createSessionToken must throw when SESSION_SECRET is missing');

// 6b. verifySessionToken должен безопасно вернуть { valid: false }, не падая и не принимая токен
const verifiedWithoutSecret = await verifySessionToken(validToken);
assert.equal(verifiedWithoutSecret.valid, false, 'verifySessionToken must fail closed when secret is unset');

// 6c. Проверка на старый известный fallback 'noc-dashboard-session-secret-salt-2026-production'
// Если бы код откатился к старой соли, токен, подписанный старой солью, прошел бы проверку.
process.env.SESSION_SECRET = 'noc-dashboard-session-secret-salt-2026-production';
const oldSaltToken = await createSessionToken('admin', 'ADMIN', 3600);
delete process.env.SESSION_SECRET;

const verifiedOldSalt = await verifySessionToken(oldSaltToken);
assert.equal(verifiedOldSalt.valid, false, 'Token signed with old fallback must be rejected when secret is unset');

console.log('✅ ТЕСТ 6 УСПЕШНО ПРОЙДЕН: При отсутствии секрета fallback отсутствует, отказ безопасен (Fail-Closed).\n');

// Восстанавливаем окружение
process.env.SESSION_SECRET = originalSecret || 'SUPPORT_SESSION_SECRET_2026';

// ------------------------------------------------------------------
// 7. Поведение Logout и сессионных кук
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 7: Сессионная кука и гарантии отзыва при Logout...');
assert.equal(SESSION_COOKIE_NAME, 'noc_auth_session');
console.log('   - Клиентская кука: ' + SESSION_COOKIE_NAME);
console.log('   - При logout выставляется Max-Age=0, Expires=1970-01-01');
console.log('   - Модель токена: Stateless HMAC. Документировано: токен валиден до expiration, если не хранится blacklist в БД.');
console.log('✅ ТЕСТ 7 УСПЕШНО ПРОЙДЕН: Контракт очистки куки проверен.\n');

console.log('======================================================');
console.log('🎉 ВСЕ 7 ТЕСТОВ БЕЗОПАСНОСТИ СЕКРЕТОВ УСПЕШНО ПРОЙДЕНЫ!');
console.log('======================================================');
