import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';

const DB_FILE_PATH = path.resolve(process.cwd(), 'storage.db');

export interface StatementWrapper<T = unknown> {
  all(...params: unknown[]): T[];
  get(...params: unknown[]): T | undefined;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface NocDatabase {
  raw: DatabaseSync;
  prepare<T = unknown>(sql: string): StatementWrapper<T>;
  exec(sql: string): void;
  pragma(query: string): unknown;
  transaction<T extends (...args: any[]) => any>(fn: T): T;
}

declare global {
  var __nocSqliteInstance: NocDatabase | undefined;
}

export function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

export function generateWorkplaceId(shopName: string, workplaceName: string): string {
  const normalizedKey = `${shopName.trim()}::${workplaceName.trim()}`;
  return crypto.createHash('sha256').update(normalizedKey, 'utf8').digest('hex');
}

/**
 * Supports both:
 * - generateErrorHash(event, errorText)
 * - generateErrorHash(workplaceId, errorType, rawError)
 */
export function generateErrorHash(param1: string, param2: string, param3?: string): string {
  const normalizedPayload =
    typeof param3 === 'string'
      ? `${param1.trim()}::${param2.trim()}::${param3.trim()}`
      : `${param1.trim()}::${param2.trim()}`;
  return crypto.createHash('sha256').update(normalizedPayload, 'utf8').digest('hex');
}

function initializeSchema(database: DatabaseSync) {
  // Настройки производительности SQLite для высокой надежности и скорости
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA synchronous = NORMAL;');
  database.exec('PRAGMA busy_timeout = 5000;');

  database.exec(`
    CREATE TABLE IF NOT EXISTS workplaces (
      id TEXT PRIMARY KEY,
      shop_name TEXT NOT NULL,
      workplace_name TEXT NOT NULL,
      remote_type TEXT DEFAULT 'NONE',
      remote_id TEXT,
      system_info_json TEXT,
      last_seen DATETIME NOT NULL
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workplace_id TEXT NOT NULL REFERENCES workplaces(id),
      error_hash TEXT NOT NULL,
      error_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'ERROR',
      raw_error TEXT NOT NULL,
      ai_diagnosis TEXT,
      ai_actions TEXT,
      occurrences_count INTEGER DEFAULT 1,
      status TEXT DEFAULT 'ACTIVE',
      resolved_at DATETIME,
      resolved_by TEXT,
      created_at DATETIME NOT NULL,
      last_occurred_at DATETIME NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_incidents_workplace_status
      ON incidents(workplace_id, status);

    CREATE INDEX IF NOT EXISTS idx_incidents_error_hash_status
      ON incidents(error_hash, status);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN', 'ENGINEER')),
      created_at DATETIME NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at DATETIME NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
      ON audit_logs(created_at DESC);
  `);

  // Проверка миграций таблицы workplaces
  const workplaceColumns = database
    .prepare("PRAGMA table_info('workplaces')")
    .all() as Array<{ name: string }>;
  const hasSystemInfo = workplaceColumns.some((col) => col.name === 'system_info_json');
  if (!hasSystemInfo) {
    database.exec('ALTER TABLE workplaces ADD COLUMN system_info_json TEXT;');
  }

  // Проверка миграций таблицы incidents
  const incidentColumns = database
    .prepare("PRAGMA table_info('incidents')")
    .all() as Array<{ name: string }>;
  const hasSeverity = incidentColumns.some((col) => col.name === 'severity');
  if (!hasSeverity) {
    database.exec("ALTER TABLE incidents ADD COLUMN severity TEXT NOT NULL DEFAULT 'ERROR';");
  }

  const hasResolvedAt = incidentColumns.some((col) => col.name === 'resolved_at');
  if (!hasResolvedAt) {
    database.exec('ALTER TABLE incidents ADD COLUMN resolved_at DATETIME;');
  }

  const hasResolvedBy = incidentColumns.some((col) => col.name === 'resolved_by');
  if (!hasResolvedBy) {
    database.exec('ALTER TABLE incidents ADD COLUMN resolved_by TEXT;');
  }

  // Автоматическая инициализация первоначальных учетных записей (при пустой таблице users)
  try {
    const userCountRow = database
      .prepare('SELECT count(*) as count FROM users')
      .get() as { count: number } | undefined;
    if (!userCountRow || userCountRow.count === 0) {
      const nowIso = new Date().toISOString();
      const insertUser = database.prepare(
        'INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
      );

      // В production пароли должны задаваться через DASHBOARD_USERNAME/DASHBOARD_PASSWORD
      // либо создаваться вручную через `node scripts/create-user.mjs <username> <password> ADMIN`
      const isProd = process.env.NODE_ENV === 'production';
      const initialAdminUser = process.env.DASHBOARD_USERNAME || 'admin';
      const initialAdminPass = process.env.DASHBOARD_PASSWORD || (isProd ? null : 'admin');

      if (initialAdminPass) {
        insertUser.run(
          'user-admin-1',
          initialAdminUser,
          hashPassword(initialAdminPass),
          'ADMIN',
          nowIso
        );
      }

      if (!isProd) {
        // Тестовый пользователь-инженер доступен только в режиме разработки/тестирования
        insertUser.run(
          'user-engineer-1',
          'engineer',
          hashPassword('engineer'),
          'ENGINEER',
          nowIso
        );
      }
    }
  } catch (err) {
    console.error('Ошибка инициализации пользователей:', err);
  }

  // Инициализация значения по умолчанию для kill_switch
  try {
    const killSwitchRow = database
      .prepare('SELECT value FROM system_settings WHERE key = ?')
      .get('kill_switch') as { value: string } | undefined;
    if (!killSwitchRow) {
      database
        .prepare('INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('kill_switch', 'false', new Date().toISOString());
    }
  } catch (err) {
    console.error('Ошибка инициализации system_settings:', err);
  }
}

function sanitizeParams(params: unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : p));
}

function createDatabaseConnection(): NocDatabase {
  const rawDb = new DatabaseSync(DB_FILE_PATH);

  const dbWrapper: NocDatabase = {
    raw: rawDb,
    prepare<T = unknown>(sql: string): StatementWrapper<T> {
      const stmt = rawDb.prepare(sql);
      return {
        all(...params: unknown[]): T[] {
          return stmt.all(...sanitizeParams(params)) as T[];
        },
        get(...params: unknown[]): T | undefined {
          return stmt.get(...sanitizeParams(params)) as T | undefined;
        },
        run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
          const res = stmt.run(...sanitizeParams(params));
          return {
            changes: res.changes,
            lastInsertRowid: res.lastInsertRowid,
          };
        },
      };
    },
    exec(sql: string): void {
      rawDb.exec(sql);
    },
    pragma(query: string): unknown {
      return rawDb.prepare(`PRAGMA ${query}`).all();
    },
    transaction<T extends (...args: any[]) => any>(fn: T): T {
      return ((...args: any[]) => {
        rawDb.exec('BEGIN IMMEDIATE');
        try {
          const result = fn(...args);
          rawDb.exec('COMMIT');
          return result;
        } catch (error) {
          rawDb.exec('ROLLBACK');
          throw error;
        }
      }) as T;
    },
  };

  initializeSchema(rawDb);
  return dbWrapper;
}

export const db: NocDatabase =
  globalThis.__nocSqliteInstance ?? createDatabaseConnection();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__nocSqliteInstance = db;
}

// ==========================================
// ХЕЛПЕРЫ ПОЛЬЗОВАТЕЛЕЙ И РОЛЕЙ (RBAC)
// ==========================================

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: 'ADMIN' | 'ENGINEER';
  created_at: string;
}

export function getUserByUsername(username: string): UserRow | null {
  try {
    const row = db
      .prepare<UserRow>('SELECT id, username, password_hash, role, created_at FROM users WHERE username = ? LIMIT 1')
      .get(username);
    return row || null;
  } catch {
    return null;
  }
}

// ==========================================
// ХЕЛПЕРЫ СИСТЕМНЫХ НАСТРОЕК И ПАУЗЫ (KILL-SWITCH)
// ==========================================

export function getSystemSetting(key: string, defaultValue = ''): string {
  try {
    const row = db
      .prepare<{ value: string }>('SELECT value FROM system_settings WHERE key = ? LIMIT 1')
      .get(key);
    return row ? row.value : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setSystemSetting(key: string, value: string): void {
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value, nowIso);
}

export function isKillSwitchActive(): boolean {
  const val = getSystemSetting('kill_switch', 'false');
  return val === 'true' || val === '1';
}

export function getKillSwitchState(): { active: boolean; updated_at: string } {
  try {
    const row = db
      .prepare<{ value: string; updated_at: string }>(
        'SELECT value, updated_at FROM system_settings WHERE key = ? LIMIT 1'
      )
      .get('kill_switch');
    if (!row) {
      return { active: false, updated_at: new Date().toISOString() };
    }
    return {
      active: row.value === 'true' || row.value === '1',
      updated_at: row.updated_at,
    };
  } catch {
    return { active: false, updated_at: new Date().toISOString() };
  }
}

export function setKillSwitch(active: boolean): { active: boolean; updated_at: string } {
  const nowIso = new Date().toISOString();
  setSystemSetting('kill_switch', active ? 'true' : 'false');
  return { active, updated_at: nowIso };
}

// ==========================================
// ХЕЛПЕРЫ ЖУРНАЛА АУДИТА (AUDIT TRAIL)
// ==========================================

export interface AuditLogRow {
  id: number;
  username: string;
  action: string;
  details: string | null;
  created_at: string;
}

export function logAudit(username: string, action: string, details?: string): void {
  try {
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO audit_logs (username, action, details, created_at)
      VALUES (?, ?, ?, ?)
    `).run(username || 'система', action, details || null, nowIso);
  } catch (err) {
    console.error('Ошибка записи audit_log:', err);
  }
}

export function getAuditLogs(limit = 50): AuditLogRow[] {
  try {
    return db
      .prepare<AuditLogRow>(
        'SELECT id, username, action, details, created_at FROM audit_logs ORDER BY created_at DESC LIMIT ?'
      )
      .all(limit);
  } catch {
    return [];
  }
}

export default db;
