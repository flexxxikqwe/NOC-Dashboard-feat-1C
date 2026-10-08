import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';

const DB_FILE_PATH = path.resolve(process.cwd(), 'storage.db');

declare global {
  // eslint-disable-next-line no-var
  var __nocSqliteInstance: Database.Database | undefined;
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

export function initializeSchema(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
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
    .prepare("PRAGMA table_info('workplaces')")
    .all() as Array<{ name: string }>;
  const hasSystemInfo = workplaceColumns.some((col) => col.name === 'system_info_json');
  if (!hasSystemInfo) {
    database.exec('ALTER TABLE workplaces ADD COLUMN system_info_json TEXT;');
  }

  // Migration check: in case incidents was created previously without severity
  const incidentColumns = database
    .prepare("PRAGMA table_info('incidents')")
    .all() as Array<{ name: string }>;
  const hasSeverity = incidentColumns.some((col) => col.name === 'severity');
  if (!hasSeverity) {
    database.exec("ALTER TABLE incidents ADD COLUMN severity TEXT NOT NULL DEFAULT 'ERROR';");
  }
}

function createDatabaseConnection(): Database.Database {
  const instance = new Database(DB_FILE_PATH);
  initializeSchema(instance);
  return instance;
}

export const db: Database.Database =
  globalThis.__nocSqliteInstance ?? createDatabaseConnection();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__nocSqliteInstance = db;
}

export default db;
