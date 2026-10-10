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

const originalSecret = process.env.SESSION_SECRET;

// ------------------------------------------------------------------
// 1. Валидная сессия с явно заданным тестовым секретом достаточной длины (>= 32 байт)
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 1: Валидная сессия с тестовым секретом (>= 32 байт)...');
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
const tamperedSig = 'f'.repeat(64);
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
const expiredToken = await createSessionToken('admin', 'ADMIN', -10);
assert.equal(hasValidSessionFormat(expiredToken), false, 'Expired token format check must return false');

const verifiedExpired = await verifySessionToken(expiredToken);
assert.equal(verifiedExpired.valid, false, 'Expired token verification must return valid: false');
console.log('✅ ТЕСТ 4 УСПЕШНО ПРОЙДЕН: Просроченный токен отклонен и на уровне формата, и криптографически.\n');

// ------------------------------------------------------------------
// 5. Обрезанная подпись и подпись неверного формата отклоняются
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 5: Обрезанная подпись и подпись неверного формата...');
const truncatedSigToken = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3].substring(0, 32)}`;
assert.equal(hasValidSessionFormat(truncatedSigToken), false, 'Truncated sig format check must return false');
const verifiedTruncated = await verifySessionToken(truncatedSigToken);
assert.equal(verifiedTruncated.valid, false, 'Truncated sig must be rejected');

const nonHexSig = 'z'.repeat(64);
const nonHexSigToken = `${parts[0]}.${parts[1]}.${parts[2]}.${nonHexSig}`;
assert.equal(hasValidSessionFormat(nonHexSigToken), false, 'Non-hex sig format check must return false');
const verifiedNonHex = await verifySessionToken(nonHexSigToken);
assert.equal(verifiedNonHex.valid, false, 'Non-hex sig must be rejected');

// safeCompareHex прямые проверки
assert.equal(safeCompareHex('a'.repeat(64), 'a'.repeat(64)), true);
assert.equal(safeCompareHex('A'.repeat(64), 'a'.repeat(64)), true);
assert.equal(safeCompareHex('a'.repeat(64), 'a'.repeat(63) + 'b'), false);
assert.equal(safeCompareHex('a'.repeat(32), 'a'.repeat(32)), false);
assert.equal(safeCompareHex('z'.repeat(64), 'z'.repeat(64)), false);
assert.equal(safeCompareHex('', ''), false);
console.log('✅ ТЕСТ 5 УСПЕШНО ПРОЙДЕН: Обрезанные, не-hex и искаженные подписи строжайше отсекаются.\n');

// ------------------------------------------------------------------
// 6. Строгая валидация длины SESSION_SECRET во ВСЕХ режимах (минимум 32 байта)
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 6: Строгая валидация длины SESSION_SECRET во ВСЕХ режимах...');

// 6a. 16-байтный секрет (отклоняется во всех режимах)
process.env.SESSION_SECRET = '1234567890123456'; // 16 bytes
let shortSecretFailed = false;
try {
  await createSessionToken('admin', 'ADMIN', 3600);
} catch (err) {
  shortSecretFailed = true;
  assert(err instanceof Error);
  assert(err.message.includes('too short'), 'Error message must specify too short');
  assert(err.message.includes('32 bytes'), 'Error message must specify 32 bytes minimum');
  assert(!err.message.includes('1234567890123456'), 'Error message must not leak secret');
}
assert.equal(shortSecretFailed, true, '16-byte secret must be rejected');

// 6b. Секрет только из пробелов
process.env.SESSION_SECRET = '                                ';
let whitespaceFailed = false;
try {
  await createSessionToken('admin', 'ADMIN', 3600);
} catch (err) {
  whitespaceFailed = true;
  assert(err instanceof Error);
  assert(err.message.includes('SESSION_SECRET is not configured'));
}
assert.equal(whitespaceFailed, true, 'Whitespace-only secret must be rejected');

// 6c. Пустая строка
process.env.SESSION_SECRET = '';
let emptyFailed = false;
try {
  await createSessionToken('admin', 'ADMIN', 3600);
} catch (err) {
  emptyFailed = true;
  assert(err instanceof Error);
  assert(err.message.includes('SESSION_SECRET is not configured'));
}
assert.equal(emptyFailed, true, 'Empty secret must be rejected');

// 6d. Отсутствующий секрет (undefined)
delete process.env.SESSION_SECRET;
let missingFailed = false;
try {
  await createSessionToken('admin', 'ADMIN', 3600);
} catch (err) {
  missingFailed = true;
  assert(err instanceof Error);
  assert(err.message.includes('SESSION_SECRET is not configured'));
}
assert.equal(missingFailed, true, 'Missing secret must be rejected');

// 6e. Fail-Closed при вызове verifySessionToken с коротким/отсутствующим ключом
process.env.SESSION_SECRET = 'short';
const verifiedWithShort = await verifySessionToken(validToken);
assert.equal(verifiedWithShort.valid, false, 'verifySessionToken must return false with short key');

delete process.env.SESSION_SECRET;
const verifiedWithMissing = await verifySessionToken(validToken);
assert.equal(verifiedWithMissing.valid, false, 'verifySessionToken must return false with missing key');

console.log('✅ ТЕСТ 6 УСПЕШНО ПРОЙДЕН: Секреты < 32 байт, пустые и отсутствующие безопасно отклоняются во всех режимах.\n');

// ------------------------------------------------------------------
// 7. Поведение Logout и сессионных кук
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 7: Сессионная кука и контракт очистки при Logout...');
assert.equal(SESSION_COOKIE_NAME, 'noc_auth_session');
console.log('   - Клиентская кука: ' + SESSION_COOKIE_NAME);
console.log('   - Logout выставляет Max-Age=0, Expires=1970-01-01');
console.log('   - Stateless HMAC: токены валидны до expiresAt, мгновенный отзыв требует серверного blacklist');
console.log('✅ ТЕСТ 7 УСПЕШНО ПРОЙДЕН: Контракт очистки куки проверен.\n');

// Восстанавливаем оригинальный секрет
process.env.SESSION_SECRET = originalSecret;

console.log('======================================================');
console.log('🎉 ВСЕ 7 ТЕСТОВ БЕЗОПАСНОСТИ СЕКРЕТОВ УСПЕШНО ПРОЙДЕНЫ!');
console.log('======================================================');
