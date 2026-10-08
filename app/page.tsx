'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  Copy,
  Check,
  Search,
  Key,
  HardDrive,
  Cpu,
  Monitor,
  Flame,
  Radio,
  Clock,
  Sparkles,
  ChevronDown,
  Layers,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';
import type { DashboardIncidentRow, DashboardWorkplaceRow } from '@/app/api/v1/dashboard/data/route';

const SUPPORT_PASSWORD = 'SuperSupportPass2026!';
const REFRESH_INTERVAL_SECONDS = 20;

export default function NocDashboardPage() {
  const [activeTab, setActiveTab] = useState<'incidents' | 'assets'>('incidents');
  const [incidents, setIncidents] = useState<DashboardIncidentRow[]>([]);
  const [workplaces, setWorkplaces] = useState<DashboardWorkplaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL_SECONDS);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [resolvingIds, setResolvingIds] = useState<Set<number>>(new Set());

  // Загрузка данных с сервера
  const fetchData = useCallback(async (isSilent = false) => {
    if (!isSilent) setRefreshing(true);
    try {
      const res = await fetch('/api/v1/dashboard/data', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setIncidents(data.incidents || []);
        setWorkplaces(data.workplaces || []);
      }
    } catch (err) {
      console.error('Failed to load NOC dashboard data', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setCountdown(REFRESH_INTERVAL_SECONDS);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Таймер автообновления
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          fetchData(true);
          return REFRESH_INTERVAL_SECONDS;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [fetchData]);

  // Копирование в буфер обмена с временной индикацией
  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey(null);
    }, 2000);
  };

  // Закрытие инцидента («Починено»)
  const handleResolve = async (incidentId: number) => {
    setResolvingIds((prev) => new Set(prev).add(incidentId));
    // Оптимистичное удаление из локального стейта
    setIncidents((prev) => prev.filter((item) => item.id !== incidentId));

    try {
      const res = await fetch(`/api/v1/incidents/${incidentId}/resolve`, {
        method: 'POST',
      });
      if (!res.ok) {
        // В случае ошибки отката восстанавливаем данные
        fetchData(true);
      }
    } catch {
      fetchData(true);
    } finally {
      setResolvingIds((prev) => {
        const next = new Set(prev);
        next.delete(incidentId);
        return next;
      });
    }
  };

  // Метрики реестра оборудования
  const stats = useMemo(() => {
    const total = workplaces.length;
    const online = workplaces.filter((w) => w.is_online).length;
    const offline = total - online;
    const noRemote = workplaces.filter((w) => !w.remote_id || w.remote_type === 'NONE').length;
    return { total, online, offline, noRemote };
  }, [workplaces]);

  // Фильтрация реестра касс на лету
  const filteredWorkplaces = useMemo(() => {
    if (!searchQuery.trim()) return workplaces;
    const q = searchQuery.toLowerCase().trim();
    return workplaces.filter(
      (w) =>
        w.shop_name.toLowerCase().includes(q) ||
        w.workplace_name.toLowerCase().includes(q) ||
        (w.remote_id && w.remote_id.toLowerCase().includes(q))
    );
  }, [workplaces, searchQuery]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-rose-500/30 selection:text-rose-200">
      {/* 1. Верхняя панель управления NOC */}
      <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 px-4 md:px-8 py-3.5">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400">
              <Radio className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base md:text-lg font-bold tracking-tight text-white">
                  1C Retail NOC Hub
                </h1>
                <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-emerald-950/70 border border-emerald-800/60 text-emerald-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                  Live Sync
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Мониторинг касс, удаленный доступ AnyDesk и AI-диагностика
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 self-end sm:self-center">
            {incidents.length > 0 && (
              <div className="flex items-center gap-1.5 bg-rose-950/80 border border-rose-800/70 text-rose-300 text-xs font-mono font-semibold px-3 py-1.5 rounded-md">
                <Flame className="w-4 h-4 text-rose-400 animate-bounce" />
                <span>Активных сбоев: {incidents.length}</span>
              </div>
            )}

            <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-md text-xs font-mono text-slate-400">
              <Clock className="w-3.5 h-3.5 text-slate-500" />
              <span>Обновление через {countdown}с</span>
            </div>

            <button
              onClick={() => fetchData()}
              disabled={refreshing}
              className="p-2 rounded-md bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-800 transition-colors disabled:opacity-50"
              title="Обновить вручную"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin text-rose-400' : ''}`} />
            </button>
          </div>
        </div>

        {/* 2. Навигационные вкладки */}
        <div className="max-w-7xl mx-auto mt-3.5 flex border-b border-slate-800/70">
          <button
            onClick={() => setActiveTab('incidents')}
            className={`pb-2.5 px-4 text-xs md:text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'incidents'
                ? 'border-rose-500 text-white font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <AlertTriangle className="w-4 h-4 text-rose-400" />
            <span>Лента инцидентов</span>
            {incidents.length > 0 && (
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40">
                {incidents.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('assets')}
            className={`pb-2.5 px-4 text-xs md:text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'assets'
                ? 'border-rose-500 text-white font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Monitor className="w-4 h-4 text-sky-400" />
            <span>Все магазины ({workplaces.length})</span>
          </button>
        </div>
      </header>

      {/* 3. Основная контентная область */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 md:px-8 py-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 text-slate-500 space-y-3">
            <RefreshCw className="w-8 h-8 animate-spin text-rose-400" />
            <p className="text-sm font-mono">Подключение к ядру телеметрии SQLite...</p>
          </div>
        ) : activeTab === 'incidents' ? (
          /* =========================================================================
             ВКЛАДКА 1: ЛЕНТА ИНЦИДЕНТОВ
             ========================================================================= */
          <div className="space-y-4">
            {incidents.length === 0 ? (
              <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl p-12 text-center flex flex-col items-center justify-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-emerald-950/60 border border-emerald-800/60 flex items-center justify-center text-emerald-400">
                  <ShieldCheck className="w-8 h-8" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">Все кассы работают штатно</h3>
                  <p className="text-slate-400 text-xs mt-1 max-w-md mx-auto">
                    Критических ошибок времени выполнения в розничной сети не зафиксировано. Телеметрия поступает в штатном режиме.
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4">
                {incidents.map((incident) => {
                  const isResolving = resolvingIds.has(incident.id);
                  const isAnyDesk = incident.remote_type === 'ANYDESK' && Boolean(incident.remote_id);
                  const isRuDesktop = incident.remote_type === 'RUDESKTOP' && Boolean(incident.remote_id);

                  return (
                    <article
                      key={incident.id}
                      className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 hover:border-slate-700/80 transition-all shadow-sm space-y-4"
                    >
                      {/* Шапка карточки */}
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 pb-3 border-b border-slate-800/60">
                        <div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-[10px] font-mono uppercase font-bold px-2 py-0.5 rounded border ${
                                incident.severity === 'WARN'
                                  ? 'bg-amber-950/70 border-amber-800 text-amber-300'
                                  : 'bg-rose-950/70 border-rose-800 text-rose-300'
                              }`}
                            >
                              {incident.severity || 'ERROR'}
                            </span>
                            <span className="text-xs font-mono text-slate-400">
                              #{incident.id}
                            </span>
                            <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                              Повторилась {incident.occurrences_count} {incident.occurrences_count === 1 ? 'раз' : 'раза'}
                            </span>
                          </div>
                          <h2 className="text-base font-bold text-white mt-1">
                            {incident.shop_name} — {incident.workplace_name}
                          </h2>
                          <p className="text-xs font-mono text-slate-400 mt-0.5">
                            Событие: <span className="text-rose-300">{incident.error_type}</span>
                          </p>
                        </div>

                        {/* Кнопки быстрого удаленного доступа */}
                        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
                          {isAnyDesk && (
                            <>
                              <a
                                href={`anydesk://${incident.remote_id}`}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-mono text-xs font-semibold shadow transition-colors"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                                <span>AnyDesk: {incident.remote_id}</span>
                              </a>
                              <button
                                onClick={() => copyToClipboard(incident.remote_id!, `desk-${incident.id}`)}
                                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors"
                                title="Скопировать AnyDesk ID"
                              >
                                {copiedKey === `desk-${incident.id}` ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </>
                          )}

                          {isRuDesktop && (
                            <button
                              onClick={() => copyToClipboard(incident.remote_id!, `rudesk-${incident.id}`)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-mono text-xs font-semibold transition-colors"
                            >
                              {copiedKey === `rudesk-${incident.id}` ? (
                                <Check className="w-3.5 h-3.5" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                              <span>RuDesktop: {incident.remote_id}</span>
                            </button>
                          )}

                          {!isAnyDesk && !isRuDesktop && (
                            <span className="text-xs font-mono text-amber-400 bg-amber-950/60 border border-amber-800/60 px-2.5 py-1 rounded-md flex items-center gap-1">
                              <AlertCircle className="w-3.5 h-3.5" />
                              Удаленный доступ не настроен
                            </span>
                          )}

                          <button
                            onClick={() => handleResolve(incident.id)}
                            disabled={isResolving}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-xs font-semibold transition-colors shadow disabled:opacity-50"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>{isResolving ? 'Закрытие...' : 'Починено'}</span>
                          </button>
                        </div>
                      </div>

                      {/* Блок AI-Triage (Диагноз и Чеклист) */}
                      {incident.ai_diagnosis && (
                        <div className="bg-slate-950/70 border-l-4 border-l-rose-500 border border-slate-800 rounded-r-lg p-4 space-y-2">
                          <div className="flex items-center gap-2 text-rose-400 font-mono text-xs font-bold uppercase tracking-wider">
                            <Sparkles className="w-4 h-4" />
                            <span>AI-Triage (Gemini Flash Диагностика)</span>
                          </div>
                          <div className="text-sm font-semibold text-white">
                            {incident.ai_diagnosis}
                          </div>
                          {incident.ai_actions && (
                            <div className="mt-2 pt-2 border-t border-slate-800/80">
                              <div className="text-xs font-mono text-slate-400 mb-1">
                                Рекомендуемые действия инженеру в AnyDesk:
                              </div>
                              <pre className="text-xs font-sans text-slate-300 whitespace-pre-wrap leading-relaxed">
                                {incident.ai_actions}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Технический сырой стек ошибки */}
                      <details className="group text-xs">
                        <summary className="cursor-pointer font-mono text-slate-400 hover:text-slate-200 flex items-center gap-1 list-none select-none">
                          <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" />
                          <span>Технический лог ошибки 1С</span>
                        </summary>
                        <div className="mt-2 p-3 bg-slate-950 rounded-lg border border-slate-800 font-mono text-[11px] text-rose-300/90 whitespace-pre-wrap overflow-x-auto">
                          {incident.raw_error}
                        </div>
                      </details>

                      {/* Футер карточки */}
                      <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 pt-1">
                        <span>Первый сбой: {new Date(incident.created_at).toLocaleTimeString('ru-RU')}</span>
                        <span>Повтор: {new Date(incident.last_occurred_at).toLocaleTimeString('ru-RU')}</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          /* =========================================================================
             ВКЛАДКА 2: ВСЕ МАГАЗИНЫ (ASSET DIRECTORY)
             ========================================================================= */
          <div className="space-y-6">
            {/* Метрики */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-slate-900 border border-slate-800 p-3.5 rounded-lg">
                <span className="text-xs font-mono text-slate-400 uppercase">Всего точек</span>
                <div className="text-2xl font-bold font-mono text-white mt-1">{stats.total}</div>
              </div>
              <div className="bg-slate-900 border border-slate-800 p-3.5 rounded-lg">
                <span className="text-xs font-mono text-emerald-400 uppercase">В сети (Онлайн)</span>
                <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">{stats.online}</div>
              </div>
              <div className="bg-slate-900 border border-slate-800 p-3.5 rounded-lg">
                <span className="text-xs font-mono text-slate-400 uppercase">Офлайн (&gt;15 мин)</span>
                <div className="text-2xl font-bold font-mono text-slate-300 mt-1">{stats.offline}</div>
              </div>
              <div className="bg-slate-900 border border-slate-800 p-3.5 rounded-lg">
                <span className="text-xs font-mono text-amber-400 uppercase">Без удаленки</span>
                <div className="text-2xl font-bold font-mono text-amber-400 mt-1">{stats.noRemote}</div>
              </div>
            </div>

            {/* Живой поиск */}
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
              <input
                type="text"
                placeholder="Поиск по названию магазина, кассе или номеру AnyDesk/RuDesktop..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-10 pr-4 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-rose-500 transition-colors"
              />
            </div>

            {/* Реестр рабочих мест */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredWorkplaces.map((wp) => {
                const hasRemote = Boolean(wp.remote_id) && wp.remote_type !== 'NONE';

                return (
                  <div
                    key={wp.id}
                    className="bg-slate-900/80 border border-slate-800 rounded-lg p-4 space-y-3 hover:border-slate-700 transition-colors flex flex-col justify-between"
                  >
                    <div>
                      {/* Статус онлайн и инциденты */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs font-mono">
                          {wp.is_online ? (
                            <span className="inline-flex items-center gap-1 text-emerald-400">
                              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                              Онлайн
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-slate-500">
                              <span className="w-2 h-2 rounded-full bg-slate-600" />
                              Офлайн
                            </span>
                          )}
                        </div>

                        {wp.active_incidents_count > 0 && (
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-rose-950 border border-rose-800 text-rose-300 font-bold">
                            {wp.active_incidents_count} сбоев
                          </span>
                        )}
                      </div>

                      {/* Название */}
                      <h3 className="font-bold text-white text-sm mt-2">{wp.shop_name}</h3>
                      <p className="text-xs text-slate-400">{wp.workplace_name}</p>

                      {/* Параметры удаленного доступа */}
                      <div className="mt-3 p-2 bg-slate-950/80 rounded border border-slate-800/80 space-y-1.5">
                        <div className="flex items-center justify-between text-xs font-mono">
                          <span className="text-slate-400">{wp.remote_type}:</span>
                          {hasRemote ? (
                            <div className="flex items-center gap-1.5">
                              {wp.remote_type === 'ANYDESK' ? (
                                <a
                                  href={`anydesk://${wp.remote_id}`}
                                  className="text-rose-400 hover:underline flex items-center gap-1"
                                >
                                  {wp.remote_id}
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              ) : (
                                <span className="text-sky-300">{wp.remote_id}</span>
                              )}
                              <button
                                onClick={() => copyToClipboard(wp.remote_id!, `wp-remote-${wp.id}`)}
                                className="p-1 hover:text-white text-slate-400"
                                title="Скопировать ID"
                              >
                                {copiedKey === `wp-remote-${wp.id}` ? (
                                  <Check className="w-3 h-3 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                              </button>
                            </div>
                          ) : (
                            <span className="text-amber-400 text-[11px]">Не обнаружен</span>
                          )}
                        </div>

                        {/* Кнопка копирования пароля поддержки */}
                        <div className="flex items-center justify-between text-xs font-mono pt-1 border-t border-slate-800/60">
                          <span className="text-slate-500 text-[11px]">Пароль саппорта:</span>
                          <button
                            onClick={() => copyToClipboard(SUPPORT_PASSWORD, `wp-pass-${wp.id}`)}
                            className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
                            title="Скопировать пароль"
                          >
                            <Key className="w-3 h-3 text-amber-400" />
                            <span>
                              {copiedKey === `wp-pass-${wp.id}` ? 'Скопирован!' : 'Скопировать'}
                            </span>
                          </button>
                        </div>
                      </div>

                      {/* Системные данные (если переданы) */}
                      {wp.system_info && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {Boolean(wp.system_info.platform_version) && (
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                              1С: {String(wp.system_info.platform_version)}
                            </span>
                          )}
                          {Boolean(wp.system_info.ram_gb) && (
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 flex items-center gap-1">
                              <Cpu className="w-2.5 h-2.5" />
                              {String(wp.system_info.ram_gb)} GB
                            </span>
                          )}
                          {Boolean(wp.system_info.os) && (
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 truncate max-w-[130px]">
                              {String(wp.system_info.os)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="text-[10px] font-mono text-slate-500 pt-2 border-t border-slate-800/60">
                      Контакт: {new Date(wp.last_seen).toLocaleString('ru-RU')}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
