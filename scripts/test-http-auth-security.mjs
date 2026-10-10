import assert from 'node:assert/strict';
import process from 'node:process';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

console.log('======================================================');
console.log('🌐 NOC DASHBOARD — HTTP REAL ENDPOINT SECURITY TESTS');
console.log('======================================================\n');

// ------------------------------------------------------------------
// ТЕСТ 1: Невалидный / поврежденный токен отклоняется на защищенных API
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 1: Проверка защищенного API /api/v1/auth/me...');

// 1a. Без куки -> 401
const noCookieRes = await fetch(`${BASE_URL}/api/v1/auth/me`);
console.log('   - Без cookie статус:', noCookieRes.status);
assert.equal(noCookieRes.status, 401, 'Expected 401 without cookie');
const noCookieJson = await noCookieRes.json();
assert.equal(noCookieJson.error, 'Требуется авторизация в пульте NOC');

// 1b. С поддельным токеном (неверная подпись) -> 401
const badSigCookie = `noc_auth_session=admin.ADMIN.${Date.now() + 3600000}.${'0'.repeat(64)}`;
const badSigRes = await fetch(`${BASE_URL}/api/v1/auth/me`, {
  headers: { Cookie: badSigCookie },
});
console.log('   - С поддельной подписью статус:', badSigRes.status);
assert.equal(badSigRes.status, 401, 'Expected 401 with forged signature');

// 1c. С не-hex подписью -> 401
const nonHexCookie = `noc_auth_session=admin.ADMIN.${Date.now() + 3600000}.${'z'.repeat(64)}`;
const nonHexRes = await fetch(`${BASE_URL}/api/v1/auth/me`, {
  headers: { Cookie: nonHexCookie },
});
console.log('   - С не-hex подписью статус:', nonHexRes.status);
assert.equal(nonHexRes.status, 401, 'Expected 401 with non-hex signature');

// 1d. С обрезанной подписью -> 401
const truncCookie = `noc_auth_session=admin.ADMIN.${Date.now() + 3600000}.${'a'.repeat(32)}`;
const truncRes = await fetch(`${BASE_URL}/api/v1/auth/me`, {
  headers: { Cookie: truncCookie },
});
console.log('   - С обрезанной подписью статус:', truncRes.status);
assert.equal(truncRes.status, 401, 'Expected 401 with truncated signature');

console.log('✅ ТЕСТ 1 УСПЕШНО ПРОЙДЕН: Все некорректные и поддельные токены строго отклоняются с кодом 401.\n');

// ------------------------------------------------------------------
// ТЕСТ 2: Вход с валидными credentials и проверка /api/v1/auth/me
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 2: Авторизация через POST /api/v1/auth/login и валидация сессии...');

const loginRes = await fetch(`${BASE_URL}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
console.log('   - Логин статус:', loginRes.status);
assert.equal(loginRes.status, 200);

const setCookie = loginRes.headers.get('set-cookie');
assert(setCookie, 'set-cookie header must be present');
const sessionCookie = setCookie.split(';')[0];
console.log('   - Получена сессионная cookie');

// Проверяем /api/v1/auth/me с выданной кукой
const meRes = await fetch(`${BASE_URL}/api/v1/auth/me`, {
  headers: { Cookie: sessionCookie },
});
console.log('   - GET /api/v1/auth/me статус:', meRes.status);
assert.equal(meRes.status, 200);
const meData = await meRes.json();
assert.equal(meData.username, 'admin');
assert.equal(meData.role, 'ADMIN');
console.log('✅ ТЕСТ 2 УСПЕШНО ПРОЙДЕН: Сессия успешно активна и возвращает данные роли ADMIN.\n');

// ------------------------------------------------------------------
// ТЕСТ 3: Поведение Logout и удаление cookie на клиенте
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 3: Завершение сеанса через POST /api/v1/auth/logout...');

const logoutRes = await fetch(`${BASE_URL}/api/v1/auth/logout`, {
  method: 'POST',
  headers: { Cookie: sessionCookie },
});
console.log('   - Logout статус:', logoutRes.status);
assert.equal(logoutRes.status, 200);

const logoutSetCookie = logoutRes.headers.get('set-cookie');
console.log('   - Logout Set-Cookie header:', logoutSetCookie);
assert(logoutSetCookie, 'Logout must send Set-Cookie header');
assert(logoutSetCookie.includes('noc_auth_session='), 'Cookie must target noc_auth_session');
assert(
  logoutSetCookie.includes('Max-Age=0') || logoutSetCookie.includes('max-age=0'),
  'Cookie must have Max-Age=0 to expire immediately in client browser'
);
console.log('✅ ТЕСТ 3 УСПЕШНО ПРОЙДЕН: Клиентская cookie корректно инвалидируется заголовком Max-Age=0.\n');

console.log('======================================================');
console.log('🎉 ВСЕ HTTP ТЕСТЫ БЕЗОПАСНОСТИ УСПЕШНО ПРОЙДЕНЫ!');
console.log('======================================================');
