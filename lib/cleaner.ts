import db from '@/lib/db';

export interface CleanupResult {
  deleted_count: number;
}

/**
 * Очищает устаревшие закрытые инциденты (status = 'RESOLVED') старше retentionDays дней.
 * Защита данных: Активные инциденты (status = 'ACTIVE') НИКОГДА не удаляются по TTL.
 * После удаления выполняет оптимизацию страниц базы данных (PRAGMA optimize).
 *
 * @param retentionDays Количество дней хранения закрытых инцидентов (по умолчанию 14).
 * @returns { deleted_count: number }
 */
export function cleanupOldIncidents(retentionDays = 14): CleanupResult {
  const safeDays = Math.max(1, Math.floor(retentionDays));

  const deleteStmt = db.prepare(`
    DELETE FROM incidents 
    WHERE status = 'RESOLVED' 
      AND last_occurred_at < datetime('now', '-' || ? || ' days');
  `);

  const info = deleteStmt.run(safeDays);

  // Оптимизация внутренних B-Tree и статистики индексов SQLite
  try {
    db.pragma('optimize');
  } catch (err) {
    console.warn('[CLEANER WARNING] PRAGMA optimize returned warning:', err);
  }

  return {
    deleted_count: info.changes,
  };
}
