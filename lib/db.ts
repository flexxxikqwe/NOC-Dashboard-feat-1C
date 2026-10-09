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

export function initializeSchema(database: NocDatabase): void {
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 10000');
  database.pragma('foreign_keys = ON');

  database.exec(`
    CREATE TABLE IF NOT EXISTS workplaces (
      id TEXT PRIMARY KEY,
      shop_name TEXT NOT NULL,
      workplace_name TEXT NOT NULL,
      remote_type TEXT NOT NULL,
      remote_id TEXT,
      system_info_json TEXT,
      last_seen DATETIME NOT NULL
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workplace_id TEXT NOT NULL REFERENCES workplaces(id) ON DELETE CASCADE,
      error_hash TEXT NOT NULL,
      error_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'ERROR',
      raw_error TEXT NOT NULL,
      ai_diagnosis TEXT,
      ai_actions TEXT,
      occurrences_count INTEGER DEFAULT 1,
      status TEXT DEFAULT 'ACTIVE',
      resolved_at DATETIME,
      created_at DATETIME NOT NULL,
      last_occurred_at DATETIME NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_incidents_workplace_status
      ON incidents(workplace_id, status);

    CREATE INDEX IF NOT EXISTS idx_incidents_error_hash_status
      ON incidents(error_hash, status);
  `);

  // Migration check: in case workplaces was created previously without system_info_json
  const workplaceColumns = database
    .prepare<{ name: string }>("PRAGMA table_info('workplaces')")
    .all();
  const hasSystemInfo = workplaceColumns.some((col) => col.name === 'system_info_json');
  if (!hasSystemInfo) {
    database.exec('ALTER TABLE workplaces ADD COLUMN system_info_json TEXT;');
  }

  // Migration check: in case incidents was created previously without severity
  const incidentColumns = database
    .prepare<{ name: string }>("PRAGMA table_info('incidents')")
    .all();
  const hasSeverity = incidentColumns.some((col) => col.name === 'severity');
  if (!hasSeverity) {
    database.exec("ALTER TABLE incidents ADD COLUMN severity TEXT NOT NULL DEFAULT 'ERROR';");
  }

  const hasResolvedAt = incidentColumns.some((col) => col.name === 'resolved_at');
  if (!hasResolvedAt) {
    database.exec("ALTER TABLE incidents ADD COLUMN resolved_at DATETIME;");
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
        run(...params: unknown[]) {
          const res = stmt.run(...sanitizeParams(params));
          return {
            changes: Number(res.changes ?? 0),
            lastInsertRowid: res.lastInsertRowid,
          };
        },
      };
    },
    exec(sql: string): void {
      rawDb.exec(sql);
    },
    pragma(query: string): unknown {
      const trimmed = query.trim();
      const pragmaSql = /^pragma\b/i.test(trimmed) ? trimmed : `PRAGMA ${trimmed};`;
      if (trimmed.includes('=') || trimmed.toLowerCase() === 'optimize') {
        rawDb.exec(pragmaSql);
        return null;
      }
      return rawDb.prepare(pragmaSql).all();
    },
    transaction<T extends (...args: any[]) => any>(fn: T): T {
      return ((...args: any[]) => {
        rawDb.exec('BEGIN');
        try {
          const result = fn(...args);
          rawDb.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            rawDb.exec('ROLLBACK');
          } catch {
            // ignore rollback error
          }
          throw error;
        }
      }) as T;
    },
  };

  initializeSchema(dbWrapper);
  return dbWrapper;
}

export const db: NocDatabase =
  globalThis.__nocSqliteInstance ?? createDatabaseConnection();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__nocSqliteInstance = db;
}

export default db;
