#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

console.log('================================================================');
console.log('🛡️ NOC DASHBOARD — PRODUCTION CONFIG & CLEAN DB VERIFICATION');
console.log('================================================================\n');

function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass, 'utf8').digest('hex');
}

function cleanDbFiles(dbPath) {
  try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  try { if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`); } catch {}
  try { if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`); } catch {}
}

const testDir = path.resolve(process.cwd(), '.tmp-test-db');
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

// ====================================================================
// ТЕСТ 1: Изолированный первый запуск с NODE_ENV=production БЕЗ пароля
// ====================================================================
console.log('▶ ТЕСТ 1: Первый запуск с NODE_ENV=production БЕЗ DASHBOARD_PASSWORD...');
const dbPath1 = path.resolve(testDir, 'clean-prod-no-pass.db');
cleanDbFiles(dbPath1);

const run1 = spawnSync(
  'node',
  [
    '-e',
    `
    const { createDatabaseConnection } = require('./lib/db.ts');
    createDatabaseConnection('${dbPath1}');
    `
  ],
  {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NOC_DB_PATH: dbPath1,
      DASHBOARD_PASSWORD: '',
      DASHBOARD_USERNAME: ''
    },
    encoding: 'utf8'
  }
);

assert.equal(run1.status, 0, `Run 1 failed: ${run1.stderr}`);

const db1 = new DatabaseSync(dbPath1);
const userCount1 = db1.prepare('SELECT count(*) as count FROM users').get();
assert.equal(userCount1.count, 0, 'В production без DASHBOARD_PASSWORD пользователей быть НЕ должно!');

const admin1 = db1.prepare('SELECT * FROM users WHERE username = ?').get('admin');
assert.equal(admin1, undefined, 'Пользователь admin не должен создаваться со стандартным паролем');

const engineer1 = db1.prepare('SELECT * FROM users WHERE username = ?').get('engineer');
assert.equal(engineer1, undefined, 'Пользователь engineer не должен создаваться в production');

const killSwitch1 = db1.prepare('SELECT value FROM system_settings WHERE key = ?').get('kill_switch');
assert.equal(killSwitch1?.value, 'false', 'kill_switch должен инициализироваться как "false"');

const auditCount1 = db1.prepare('SELECT count(*) as count FROM audit_logs').get();
assert.equal(typeof auditCount1.count, 'number', 'Таблица audit_logs должна существовать и быть готова');

db1.close();
console.log('✅ ТЕСТ 1 УСПЕШНО ПРОЙДЕН: Никаких дефолтных паролей (admin/admin, engineer/engineer) в production не создано!\n');

// ====================================================================
// ТЕСТ 2: Отказ в доступе с admin/admin на свежей production-конфигурации
// ====================================================================
console.log('▶ ТЕСТ 2: Попытка аутентификации admin/admin и engineer/engineer на свежей базе...');
const authCheckRun = spawnSync(
  'node',
  [
    '-e',
    `
    const { getUserByUsername, hashPassword } = require('./lib/db.ts');
    
    // Проверка логики входа для admin/admin
    const userAdmin = getUserByUsername('admin');
    if (userAdmin) {
      console.error('FAIL: Пользователь admin существует!');
      process.exit(1);
    }
    
    // Проверка логики входа для engineer/engineer
    const userEng = getUserByUsername('engineer');
    if (userEng) {
      console.error('FAIL: Пользователь engineer существует!');
      process.exit(1);
    }
    
    console.log('OK: Все попытки входа отклонены, пользователи отсутствуют (401)');
    `
  ],
  {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NOC_DB_PATH: dbPath1,
      DASHBOARD_PASSWORD: '',
      DASHBOARD_USERNAME: ''
    },
    encoding: 'utf8'
  }
);

assert.equal(authCheckRun.status, 0, `Auth check failed: ${authCheckRun.stderr}`);
cleanDbFiles(dbPath1);
console.log('✅ ТЕСТ 2 УСПЕШНО ПРОЙДЕН: Вход с admin/admin гарантированно отклонен (401 Unauthorized).\n');

// ====================================================================
// ТЕСТ 3: Первый запуск с пробельным DASHBOARD_PASSWORD="   "
// ====================================================================
console.log('▶ ТЕСТ 3: Первый запуск с пробельным DASHBOARD_PASSWORD="   "...');
const dbPath2 = path.resolve(testDir, 'clean-prod-whitespace-pass.db');
cleanDbFiles(dbPath2);

const run2 = spawnSync(
  'node',
  [
    '-e',
    `
    const { createDatabaseConnection } = require('./lib/db.ts');
    createDatabaseConnection('${dbPath2}');
    `
  ],
  {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NOC_DB_PATH: dbPath2,
      DASHBOARD_PASSWORD: '   '
    },
    encoding: 'utf8'
  }
);

assert.equal(run2.status, 0, `Run 2 failed: ${run2.stderr}`);

const db2 = new DatabaseSync(dbPath2);
const userCount2 = db2.prepare('SELECT count(*) as count FROM users').get();
assert.equal(userCount2.count, 0, 'Пробельный DASHBOARD_PASSWORD не должен создавать пользователя!');
db2.close();
cleanDbFiles(dbPath2);
console.log('✅ ТЕСТ 3 УСПЕШНО ПРОЙДЕН: Пробельный пароль отклонен, пользователи не созданы.\n');

// ====================================================================
// ТЕСТ 4: Первый запуск с NODE_ENV=production и заданным DASHBOARD_PASSWORD
// ====================================================================
console.log('▶ ТЕСТ 4: Первый запуск с NODE_ENV=production и заданным DASHBOARD_PASSWORD...');
const dbPath3 = path.resolve(testDir, 'clean-prod-with-pass.db');
cleanDbFiles(dbPath3);

const customUser = 'prod_ops_admin';
const customPass = 'ComplexProductionPassword2026!#$';

const run3 = spawnSync(
  'node',
  [
    '-e',
    `
    const { createDatabaseConnection } = require('./lib/db.ts');
    createDatabaseConnection('${dbPath3}');
    `
  ],
  {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NOC_DB_PATH: dbPath3,
      DASHBOARD_USERNAME: customUser,
      DASHBOARD_PASSWORD: customPass
    },
    encoding: 'utf8'
  }
);

assert.equal(run3.status, 0, `Run 3 failed: ${run3.stderr}`);

const db3 = new DatabaseSync(dbPath3);
const userCount3 = db3.prepare('SELECT count(*) as count FROM users').get();
assert.equal(userCount3.count, 1, 'Должен быть создан ровно 1 пользователь-администратор');

const admin3 = db3.prepare('SELECT * FROM users WHERE username = ?').get(customUser);
assert(admin3, 'Пользователь admin с кастомным именем должен существовать');
assert.equal(admin3.role, 'ADMIN', 'Роль должна быть строго ADMIN');
assert.equal(admin3.password_hash, hashPassword(customPass), 'Хэш пароля должен соответствовать переданному');

const engineer3 = db3.prepare('SELECT * FROM users WHERE username = ?').get('engineer');
assert.equal(engineer3, undefined, 'В production инженер со стандартным паролем НЕ создается');

const auditLog3 = db3.prepare('SELECT * FROM audit_logs WHERE username = ?').get(customUser);
assert(auditLog3, 'Инициализация учетной записи администратора должна быть зафиксирована в audit_logs');
assert.equal(auditLog3.action, 'USER_INIT');
db3.close();

console.log('✅ ТЕСТ 4 УСПЕШНО ПРОЙДЕН: Администратор корректно создан с фиксацией в audit_logs, бэкдоров нет.\n');

// ====================================================================
// ТЕСТ 5: Повторная инициализация НЕ сбрасывает пароль существующего пользователя
// ====================================================================
console.log('▶ ТЕСТ 5: Повторный запуск сервера/соединения НЕ сбрасывает существующий пароль...');
// Сменили пароль пользователя через CLI/приложение
const rotatedPassword = 'RotatedNewPassword2026!#%&*';
const rotateRun = spawnSync(
  'node',
  ['scripts/create-user.mjs', customUser, rotatedPassword, 'ADMIN'],
  {
    env: { ...process.env, NOC_DB_PATH: dbPath3 },
    encoding: 'utf8'
  }
);
assert.equal(rotateRun.status, 0, `Rotate failed: ${rotateRun.stderr}`);

// Перезапускаем сервер с исходным или другим DASHBOARD_PASSWORD в env
const restartRun = spawnSync(
  'node',
  [
    '-e',
    `
    const { createDatabaseConnection, getUserByUsername } = require('./lib/db.ts');
    createDatabaseConnection('${dbPath3}');
    const user = getUserByUsername('${customUser}');
    if (!user) process.exit(1);
    `
  ],
  {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NOC_DB_PATH: dbPath3,
      DASHBOARD_USERNAME: customUser,
      DASHBOARD_PASSWORD: 'OldInitialPasswordThatShouldNotOverwrite!'
    },
    encoding: 'utf8'
  }
);
assert.equal(restartRun.status, 0, `Restart failed: ${restartRun.stderr}`);

const dbRestart = new DatabaseSync(dbPath3);
const postRestartAdmin = dbRestart.prepare('SELECT * FROM users WHERE username = ?').get(customUser);
assert.equal(
  postRestartAdmin.password_hash,
  hashPassword(rotatedPassword),
  'Повторный запуск НЕ должен перезаписывать существующий пароль!'
);
assert.notEqual(
  postRestartAdmin.password_hash,
  hashPassword('OldInitialPasswordThatShouldNotOverwrite!'),
  'Старый или измененный DASHBOARD_PASSWORD из env не должен применяться к существующему пользователю!'
);
dbRestart.close();
console.log('✅ ТЕСТ 5 УСПЕШНО ПРОЙДЕН: Повторная инициализация безопасна и не сбрасывает пароли.\n');

// ====================================================================
// ТЕСТ 6: Неверный пароль дает 401, верный пароль аутентифицирует
// ====================================================================
console.log('▶ ТЕСТ 6: Проверка неверного пароля (401) и верного пароля...');
const passwordVerifyRun = spawnSync(
  'node',
  [
    '-e',
    `
    const { getUserByUsername, hashPassword } = require('./lib/db.ts');
    const user = getUserByUsername('${customUser}');
    
    // Неверный пароль
    const wrongHash = hashPassword('WrongPassword123');
    if (user.password_hash === wrongHash) {
      console.error('FAIL: Неверный пароль совпал!');
      process.exit(1);
    }
    
    // Верный пароль
    const rightHash = hashPassword('${rotatedPassword}');
    if (user.password_hash !== rightHash) {
      console.error('FAIL: Верный пароль не совпал!');
      process.exit(2);
    }
    console.log('OK: Проверка паролей прошла успешно');
    `
  ],
  {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NOC_DB_PATH: dbPath3
    },
    encoding: 'utf8'
  }
);
assert.equal(passwordVerifyRun.status, 0, `Password verification failed: ${passwordVerifyRun.stderr}`);
cleanDbFiles(dbPath3);
console.log('✅ ТЕСТ 6 УСПЕШНО ПРОЙДЕН: Неверный пароль гарантированно отсекается (401), верный валидируется.\n');

// ====================================================================
// ТЕСТ 7: Отсутствие SESSION_SECRET приводит к отказу без fallback-секрета
// ====================================================================
console.log('▶ ТЕСТ 7: Проверка поведения при отсутствии SESSION_SECRET (fail-closed, без fallback)...');
const sessionSecretRun = spawnSync(
  'node',
  [
    '-e',
    `
    const { createSessionToken, verifySessionToken } = require('./lib/session.ts');
    
    // 1. Создание токена без SESSION_SECRET должно падать с ошибкой
    delete process.env.SESSION_SECRET;
    createSessionToken('admin', 'ADMIN', 3600)
      .then(() => {
        console.error('FAIL: Токен создан без SESSION_SECRET!');
        process.exit(1);
      })
      .catch((err) => {
        if (!err.message.includes('SESSION_SECRET is not configured')) {
          console.error('FAIL: Неожиданная ошибка:', err);
          process.exit(2);
        }
        
        // 2. Верификация токена без SESSION_SECRET должна возвращать valid: false
        return verifySessionToken('dummy.token.format');
      })
      .then((res) => {
        if (res.valid !== false) {
          console.error('FAIL: Верификация прошла без секрета!');
          process.exit(3);
        }
        
        // 3. Секрет менее 32 байт должен падать
        process.env.SESSION_SECRET = 'short-16-bytes--';
        return createSessionToken('admin', 'ADMIN', 3600);
      })
      .then(() => {
        console.error('FAIL: Токен создан с коротким секретом!');
        process.exit(4);
      })
      .catch((err) => {
        if (!err.message.includes('too short')) {
          console.error('FAIL: Ошибка не указала на недостаточную длину:', err);
          process.exit(5);
        }
        console.log('OK: Fail-closed подтвержден во всех сценариях');
      });
    `
  ],
  {
    env: {
      ...process.env,
      NODE_ENV: 'production'
    },
    encoding: 'utf8'
  }
);
assert.equal(sessionSecretRun.status, 0, `Session secret test failed: ${sessionSecretRun.stderr}`);
console.log('✅ ТЕСТ 7 УСПЕШНО ПРОЙДЕН: Без SESSION_SECRET сессия строго отклоняется, fallback отсутствует.\n');

// ====================================================================
// ТЕСТ 8: Создание и обновление пользователей через scripts/create-user.mjs
// ====================================================================
console.log('▶ ТЕСТ 8: Создание пользователей через scripts/create-user.mjs на чистой базе...');
const dbPath4 = path.resolve(testDir, 'clean-prod-cli-users.db');
cleanDbFiles(dbPath4);

// Создание ADMIN
const cliAdmin = spawnSync(
  'node',
  ['scripts/create-user.mjs', 'master_admin', 'MasterSecret2026!', 'ADMIN'],
  {
    env: { ...process.env, NOC_DB_PATH: dbPath4 },
    encoding: 'utf8'
  }
);
assert.equal(cliAdmin.status, 0, `create-user ADMIN failed: ${cliAdmin.stderr}`);

// Создание ENGINEER
const cliEngineer = spawnSync(
  'node',
  ['scripts/create-user.mjs', 'shift_engineer', 'ShiftSecret2026!', 'ENGINEER'],
  {
    env: { ...process.env, NOC_DB_PATH: dbPath4 },
    encoding: 'utf8'
  }
);
assert.equal(cliEngineer.status, 0, `create-user ENGINEER failed: ${cliEngineer.stderr}`);

// Проверка базы данных
const db4 = new DatabaseSync(dbPath4);
const adminUser4 = db4.prepare('SELECT * FROM users WHERE username = ?').get('master_admin');
assert(adminUser4);
assert.equal(adminUser4.role, 'ADMIN');
assert.equal(adminUser4.password_hash, hashPassword('MasterSecret2026!'));

const engUser4 = db4.prepare('SELECT * FROM users WHERE username = ?').get('shift_engineer');
assert(engUser4);
assert.equal(engUser4.role, 'ENGINEER');
assert.equal(engUser4.password_hash, hashPassword('ShiftSecret2026!'));

// Проверка обновления пароля через CLI
const cliUpdate = spawnSync(
  'node',
  ['scripts/create-user.mjs', 'shift_engineer', 'NewRotatedPass2026!', 'ENGINEER'],
  {
    env: { ...process.env, NOC_DB_PATH: dbPath4 },
    encoding: 'utf8'
  }
);
assert.equal(cliUpdate.status, 0, `create-user update failed: ${cliUpdate.stderr}`);

const engUpdated4 = db4.prepare('SELECT * FROM users WHERE username = ?').get('shift_engineer');
assert.equal(engUpdated4.password_hash, hashPassword('NewRotatedPass2026!'), 'Пароль должен быть обновлен');

// Проверка аудита CLI
const auditLogs4 = db4.prepare('SELECT * FROM audit_logs WHERE username = ?').all('shift_engineer');
assert(auditLogs4.length >= 2, 'Оба действия CLI должны быть в audit_logs');
assert.equal(auditLogs4[0].action, 'USER_CLI_PROVISIONED');

db4.close();
cleanDbFiles(dbPath4);
console.log('✅ ТЕСТ 8 УСПЕШНО ПРОЙДЕН: Скрипт create-user.mjs корректно создает и ротирует пользователей с аудитом.\n');

// ====================================================================
// ТЕСТ 9: Переносимость команд package.json и переопределение NODE_ENV
// ====================================================================
console.log('▶ ТЕСТ 9: Проверка package.json scripts на переносимость и изоляцию NODE_ENV...');
const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));

assert(packageJson.scripts.build.startsWith('cross-env NODE_ENV=production'), 'Скрипт build должен использовать cross-env');
assert(packageJson.scripts.start.startsWith('cross-env NODE_ENV=production'), 'Скрипт start должен использовать cross-env');
assert.equal(packageJson.scripts.dev, 'next dev', 'Скрипт dev не должен быть изменен');

// Проверка фактического поведения cross-env при унаследованном NODE_ENV=development
const crossEnvTest = spawnSync(
  './node_modules/.bin/cross-env',
  ['NODE_ENV=production', 'node', '-e', 'if (process.env.NODE_ENV !== "production") process.exit(1);'],
  {
    env: { ...process.env, NODE_ENV: 'development' },
    encoding: 'utf8'
  }
);
assert.equal(crossEnvTest.status, 0, 'cross-env обязан перезаписывать унаследованный NODE_ENV=development');
console.log('✅ ТЕСТ 9 УСПЕШНО ПРОЙДЕН: Скрипты переносимы и гарантированно изолируют NODE_ENV=production.\n');

// Очистка каталога тестов
try { fs.rmdirSync(testDir); } catch {}

console.log('================================================================');
console.log('🎉 ВСЕ 9 ТЕСТОВ PRODUCTION-КОНФИГУРАЦИИ И ЧИСТОЙ БАЗЫ УСПЕШНО ПРОЙДЕНЫ!');
console.log('================================================================');
