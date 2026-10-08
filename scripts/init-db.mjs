import Database from 'better-sqlite3';
import path from 'node:path';
import process from 'node:process';

const DB_FILE_PATH = path.resolve(process.cwd(), 'storage.db');

function verifyAndInitDatabase() {
  console.log(`[INIT-DB] Connecting to SQLite database at: ${DB_FILE_PATH}`);

  const db = new Database(DB_FILE_PATH);

  try {
    const journalModeResult = db.pragma('journal_mode = WAL');
    const currentJournalMode =
      Array.isArray(journalModeResult) && journalModeResult.length > 0
        ? journalModeResult[0].journal_mode
        : String(journalModeResult);

    db.pragma('foreign_keys = ON');
    const foreignKeysResult = db.pragma('foreign_keys');
    const foreignKeysEnabled =
      Array.isArray(foreignKeysResult) && foreignKeysResult.length > 0
        ? foreignKeysResult[0].foreign_keys === 1
        : false;

    if (String(currentJournalMode).toLowerCase() !== 'wal') {
      throw new Error(
        `Expected PRAGMA journal_mode to be 'wal', but got '${currentJournalMode}'`
      );
    }

    if (!foreignKeysEnabled) {
      throw new Error('Expected PRAGMA foreign_keys to be enabled (1)');
    }

    console.log(`[INIT-DB] PRAGMA journal_mode verified: ${currentJournalMode}`);
    console.log(`[INIT-DB] PRAGMA foreign_keys verified: ON (1)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS workplaces (
        id TEXT PRIMARY KEY,
        shop_name TEXT NOT NULL,
        workplace_name TEXT NOT NULL,
        remote_type TEXT NOT NULL,
        remote_id TEXT,
        last_seen DATETIME NOT NULL
      );

      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workplace_id TEXT NOT NULL REFERENCES workplaces(id) ON DELETE CASCADE,
        error_hash TEXT NOT NULL,
        error_type TEXT NOT NULL,
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

    const masterObjects = db
      .prepare(
        `SELECT type, name, tbl_name
         FROM sqlite_master
         WHERE type IN ('table', 'index')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY type DESC, name ASC`
      )
      .all();

    const tables = masterObjects.filter((item) => item.type === 'table').map((item) => item.name);
    const indexes = masterObjects.filter((item) => item.type === 'index').map((item) => item.name);

    console.log('[INIT-DB] Created tables in sqlite_master:', tables);
    console.log('[INIT-DB] Created indexes in sqlite_master:', indexes);

    const requiredTables = ['workplaces', 'incidents'];
    for (const tableName of requiredTables) {
      if (!tables.includes(tableName)) {
        throw new Error(`Required table '${tableName}' is missing in sqlite_master`);
      }
    }

    const requiredIndexes = [
      'idx_incidents_workplace_status',
      'idx_incidents_error_hash_status',
    ];
    for (const indexName of requiredIndexes) {
      if (!indexes.includes(indexName)) {
        throw new Error(`Required index '${indexName}' is missing in sqlite_master`);
      }
    }

    console.log('[INIT-DB] Database initialization and verification completed successfully.');
  } finally {
    db.close();
  }
}

try {
  verifyAndInitDatabase();
} catch (error) {
  console.error('[INIT-DB] FATAL ERROR:', error instanceof Error ? error.message : error);
  process.exit(1);
}
