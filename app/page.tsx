import db from '@/lib/db';
import type { Incident, Workplace } from '@/types/telemetry';
import { Database as DatabaseIcon, ShieldCheck, HardDrive, Layers, CheckCircle2, Activity, Server, Radio } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  const journalModeRow = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
  const foreignKeysRow = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;

  const journalMode = journalModeRow?.[0]?.journal_mode ?? 'unknown';
  const foreignKeysEnabled = foreignKeysRow?.[0]?.foreign_keys === 1;

  const workplacesCount = (
    db.prepare(`SELECT COUNT(*) as count FROM workplaces`).get() as { count: number }
  ).count;

  const activeIncidentsCount = (
    db.prepare(`SELECT COUNT(*) as count FROM incidents WHERE status = 'ACTIVE'`).get() as { count: number }
  ).count;

  const totalIncidentsCount = (
    db.prepare(`SELECT COUNT(*) as count FROM incidents`).get() as { count: number }
  ).count;

  const recentWorkplaces = db
    .prepare(`SELECT * FROM workplaces ORDER BY last_seen DESC LIMIT 5`)
    .all() as Workplace[];

  const recentIncidents = db
    .prepare(`SELECT * FROM incidents ORDER BY last_occurred_at DESC LIMIT 5`)
    .all() as Array<Incident & { severity?: string }>;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="border-b border-slate-800 pb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-3 py-1 rounded-md mb-3">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Фаза 2 • Шаг 2.1 — Серверное обслуживание (TTL) и OTA-дистрибуция развернуты
            </div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-white flex items-center gap-3">
              <Activity className="w-7 h-7 text-emerald-400" />
              Retail NOC Dashboard — Core Monitoring & OTA Hub
            </h1>
            <p className="text-slate-400 text-sm mt-1">
              Прием телеметрии, защищенный шлюз OTA-обновлений (<code className="text-emerald-300 font-mono">/api/v1/version</code>) и регламентная очистка БД по TTL (<code className="text-sky-300 font-mono">/api/v1/maintenance/cleanup</code>).
            </p>
          </div>

          <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-4 py-2 rounded-lg text-xs font-mono text-slate-300">
            <Radio className="w-4 h-4 text-emerald-400 animate-pulse" />
            <span>Шлюз активен: <strong className="text-white">/api/v1/telemetry</strong></span>
          </div>
        </header>

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs font-mono uppercase">
              <span>Режим журнала</span>
              <HardDrive className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="mt-2 text-2xl font-mono font-bold text-emerald-400 uppercase">
              {journalMode}
            </div>
            <p className="text-xs text-slate-500 mt-1">Параллельное чтение (WAL)</p>
          </div>

          <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs font-mono uppercase">
              <span>Безопасность API</span>
              <ShieldCheck className="w-4 h-4 text-sky-400" />
            </div>
            <div className="mt-2 text-2xl font-mono font-bold text-sky-400">
              64 KB Guard
            </div>
            <p className="text-xs text-slate-500 mt-1">Bearer токен + Payload limit</p>
          </div>

          <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs font-mono uppercase">
              <span>Кассовые узлы</span>
              <DatabaseIcon className="w-4 h-4 text-indigo-400" />
            </div>
            <div className="mt-2 text-2xl font-mono font-bold text-white">
              {workplacesCount}
            </div>
            <p className="text-xs text-slate-500 mt-1">Таблица workplaces в БД</p>
          </div>

          <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-4">
            <div className="flex items-center justify-between text-slate-400 text-xs font-mono uppercase">
              <span>Инциденты (Active/Total)</span>
              <Layers className="w-4 h-4 text-amber-400" />
            </div>
            <div className="mt-2 text-2xl font-mono font-bold text-white">
              <span className="text-amber-400">{activeIncidentsCount}</span> / {totalIncidentsCount}
            </div>
            <p className="text-xs text-slate-500 mt-1">Дедупликация по hash активна</p>
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className="bg-slate-900/70 border border-slate-800 rounded-lg p-5">
            <h2 className="text-sm font-mono uppercase tracking-wider text-slate-300 mb-3 flex items-center justify-between">
              <span>Последние кассовые узлы</span>
              <Server className="w-4 h-4 text-slate-500" />
            </h2>
            {recentWorkplaces.length === 0 ? (
              <p className="text-sm text-slate-500 py-4">Нет зарегистрированных касс. Отправьте пакет телеметрии.</p>
            ) : (
              <div className="space-y-3 font-mono text-xs">
                {recentWorkplaces.map((wp) => (
                  <div key={wp.id} className="bg-slate-950/80 border border-slate-800/80 p-3 rounded space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-200">{wp.shop_name} — {wp.workplace_name}</span>
                      <span className="text-emerald-400 bg-emerald-950/80 border border-emerald-800/50 px-2 py-0.5 rounded text-[10px]">
                        {wp.remote_type}: {wp.remote_id || 'N/A'}
                      </span>
                    </div>
                    <div className="text-slate-500 text-[11px] truncate">
                      ID: {wp.id}
                    </div>
                    <div className="text-slate-400 text-[11px]">
                      Last seen: {new Date(wp.last_seen).toLocaleString('ru-RU')}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="bg-slate-900/70 border border-slate-800 rounded-lg p-5">
            <h2 className="text-sm font-mono uppercase tracking-wider text-slate-300 mb-3 flex items-center justify-between">
              <span>Последние инциденты</span>
              <Layers className="w-4 h-4 text-amber-500" />
            </h2>
            {recentIncidents.length === 0 ? (
              <p className="text-sm text-slate-500 py-4">Активных инцидентов нет.</p>
            ) : (
              <div className="space-y-3 font-mono text-xs">
                {recentIncidents.map((inc) => (
                  <div key={inc.id} className="bg-slate-950/80 border border-slate-800/80 p-3 rounded space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-red-400 font-bold">{inc.error_type}</span>
                      <span className="text-amber-300 bg-amber-950/60 border border-amber-800/60 px-2 py-0.5 rounded text-[10px]">
                        Повторов: {inc.occurrences_count}
                      </span>
                    </div>
                    <p className="text-slate-300 text-[11px] line-clamp-2">
                      {inc.raw_error}
                    </p>
                    <div className="flex items-center justify-between text-slate-500 text-[10px]">
                      <span>Hash: {inc.error_hash.substring(0, 16)}...</span>
                      <span>{new Date(inc.last_occurred_at).toLocaleString('ru-RU')}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
