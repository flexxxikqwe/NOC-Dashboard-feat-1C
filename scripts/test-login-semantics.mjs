import assert from 'node:assert/strict';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_FILE_PATH = path.resolve(process.cwd(), 'storage.db');

function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass, 'utf8').digest('hex');
}

console.log('======================================================');
console.log('🧪 NOC DASHBOARD — LOGIN SEMANTICS & DB TRUTH TESTS');
console.log('======================================================\n');

const db = new DatabaseSync(DB_FILE_PATH);

// Убедимся, что начальный admin существует
const originalAdmin = db.prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?').get('admin');
assert(originalAdmin, 'Admin user must exist in DB for testing');

// ------------------------------------------------------------------
// ТЕСТ 1: Правильный пароль из БД -> 200 OK
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 1: Вход с правильным паролем из БД (admin/admin)...');
const res1 = await fetch(`${BASE_URL}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
console.log('   - Статус ответа:', res1.status);
assert.equal(res1.status, 200);
const data1 = await res1.json();
assert.equal(data1.success, true);
assert.equal(data1.user.username, 'admin');
console.log('✅ ТЕСТ 1 УСПЕШНО ПРОЙДЕН: Вход по паролю из БД успешен.\n');

// ------------------------------------------------------------------
// ТЕСТ 2: Неверный пароль -> 401 Unauthorized
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 2: Вход с неверным паролем (admin/wrong-password)...');
const res2 = await fetch(`${BASE_URL}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
});
console.log('   - Статус ответа:', res2.status);
assert.equal(res2.status, 401);
const data2 = await res2.json();
assert.equal(data2.error, 'Неверный логин или пароль');
console.log('✅ ТЕСТ 2 УСПЕШНО ПРОЙДЕН: Неверный пароль возвращает 401.\n');

// ------------------------------------------------------------------
// ТЕСТ 3: Отсутствующий в БД пользователь -> 401 Unauthorized
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 3: Вход под несуществующим пользователем (non_existent_user)...');
const res3 = await fetch(`${BASE_URL}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'non_existent_user', password: 'any_password' }),
});
console.log('   - Статус ответа:', res3.status);
assert.equal(res3.status, 401);
const data3 = await res3.json();
assert.equal(data3.error, 'Неверный логин или пароль');
console.log('✅ ТЕСТ 3 УСПЕШНО ПРОЙДЕН: Несуществующий пользователь возвращает 401.\n');

// ------------------------------------------------------------------
// ТЕСТ 4: Изменение пароля в БД делает старый пароль недействительным
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 4: Изменение пароля в БД: проверка, что БД — единственный источник истины...');
const newPassword = 'newSecretAdminPassword2026!';
const newHash = hashPassword(newPassword);

// Обновляем хэш пароля admin в БД
db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(newHash, 'admin');

// 4a. Попытка входа со старым паролем (даже если он совпадает с env DASHBOARD_PASSWORD='admin') -> 401
const resOldPass = await fetch(`${BASE_URL}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
});
console.log('   - Вход со старым паролем (из env) статус:', resOldPass.status);
assert.equal(resOldPass.status, 401, 'Old password must be rejected once changed in DB');

// 4b. Вход с новым паролем из БД -> 200 OK
const resNewPass = await fetch(`${BASE_URL}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: newPassword }),
});
console.log('   - Вход с новым паролем из БД статус:', resNewPass.status);
assert.equal(resNewPass.status, 200, 'New DB password must succeed');
const dataNewPass = await resNewPass.json();
assert.equal(dataNewPass.success, true);

// Восстанавливаем оригинальный хэш пароля в БД
db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(originalAdmin.password_hash, 'admin');

console.log('✅ ТЕСТ 4 УСПЕШНО ПРОЙДЕН: Смена пароля в БД исключает вход по старому паролю, обход через env заблокирован.\n');

// ------------------------------------------------------------------
// ТЕСТ 5: Проверка поведения при пустых полях username/password
// ------------------------------------------------------------------
console.log('▶ ТЕСТ 5: Отправка пустых или отсутствующих полей credentials...');
const resEmpty = await fetch(`${BASE_URL}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: '', password: '' }),
});
console.log('   - Пустые credentials статус:', resEmpty.status);
assert.equal(resEmpty.status, 400);

const resNoBody = await fetch(`${BASE_URL}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: 'invalid-json',
});
console.log('   - Некорректный JSON статус:', resNoBody.status);
assert.equal(resNoBody.status, 400);

console.log('✅ ТЕСТ 5 УСПЕШНО ПРОЙДЕН: Некорректные запросы отклоняются с кодом 400.\n');

console.log('======================================================');
console.log('🎉 ВСЕ ТЕСТЫ СЕМАНТИКИ ВХОДА И БД УСПЕШНО ПРОЙДЕНЫ!');
console.log('======================================================');
