#!/usr/bin/env node
/**
 * Скрипт создания и обновления пользователей системы мониторинга 1С (NOC Dashboard).
 * Использование:
 *   node scripts/create-user.mjs <username> <password> [ADMIN|ENGINEER]
 *
 * Пример:
 *   node scripts/create-user.mjs ivan pass123 ENGINEER
 *   node scripts/create-user.mjs boss master2026 ADMIN
 */

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '..', 'storage.db');

const args = process.argv.slice(2);

if (args.length < 2) {
  console.log(`
Использование:
  node scripts/create-user.mjs <username> <password> [ADMIN|ENGINEER]

Параметры:
  username  - Имя пользователя (логин)
  password  - Пароль
  role      - Роль: ADMIN (Администратор) или ENGINEER (Инженер, по умолчанию)

Примеры:
  node scripts/create-user.mjs alexey secretPass123 ENGINEER
  node scripts/create-user.mjs supervisor superPass2026 ADMIN
`);
  process.exit(1);
}

const rawUsername = args[0].trim();
const rawPassword = args[1];
const rawRole = (args[2] || 'ENGINEER').toUpperCase().trim();

if (!rawUsername || !rawPassword) {
  console.error('Ошибка: Логин и пароль не могут быть пустыми.');
  process.exit(1);
}

if (rawRole !== 'ADMIN' && rawRole !== 'ENGINEER') {
  console.error(`Ошибка: Недопустимая роль "${rawRole}". Доступные роли: ADMIN, ENGINEER.`);
  process.exit(1);
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

try {
  const db = new DatabaseSync(dbPath);

  // Убедимся, что таблица users существует
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN', 'ENGINEER')),
      created_at DATETIME NOT NULL
    );
  `);

  const passwordHash = hashPassword(rawPassword);
  const nowIso = new Date().toISOString();
  const userId = `user-${rawUsername}-${crypto.randomBytes(4).toString('hex')}`;

  const stmt = db.prepare(`
    INSERT INTO users (id, username, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash,
      role = excluded.role;
  `);

  stmt.run(userId, rawUsername, passwordHash, rawRole, nowIso);

  console.log(`✓ Пользователь [${rawUsername}] успешно создан с ролью [${rawRole}].`);
} catch (error) {
  console.error('Ошибка при работе с базой данных SQLite:', error);
  process.exit(1);
}
