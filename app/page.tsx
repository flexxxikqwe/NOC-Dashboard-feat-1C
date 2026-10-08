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
  Cpu,
  Monitor,
  Flame,
  Clock,
  Sparkles,
  ChevronDown,
  CheckCircle2,
  AlertCircle,
  X,
  Filter,
  FileText,
  ArrowRight,
} from 'lucide-react';
import type { DashboardIncidentRow, DashboardWorkplaceRow } from '@/app/api/v1/dashboard/data/route';

const SUPPORT_PASSWORD = 'SuperSupportPass2026!';
const REFRESH_INTERVAL_SECONDS = 20;

/**
 * Утилита форматирования времени относительно текущего момента:
 * - < 10 сек  -> "только что"
 * - < 60 сек  -> "N сек назад"
 * - < 60 мин  -> "N мин назад"
 * - < 24 ч    -> "N ч назад"
 * - >= 24 ч   -> "N дн назад"
 */
function formatRelativeTime(dateString: string | null | undefined): string {
  if (!dateString) return 'нет данных';
  const timestamp = new Date(dateString).getTime();
  if (isNaN(timestamp)) return 'нет данных';

  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 0 || diffSec < 10) return 'только что';
  if (diffSec < 60) return `${diffSec} сек назад`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} мин назад`;

  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} ч назад`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} дн назад`;
}

/**
 * Вспомогательное форматирование точной даты для подсказок (title)
 */
function formatExactTime(dateString: string | null | undefined): string {
  if (!dateString) return 'нет данных';
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return 'нет данных';
  return d.toLocaleString('ru-RU');
}

export default function NocDashboardPage() {
  const [activeTab, setActiveTab] = useState<'incidents' | 'assets'>('incidents');
  const [incidents, setIncidents] = useState<DashboardIncidentRow[]>([]);
  const [workplaces, setWorkplaces] = useState<DashboardWorkplaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL_SECONDS);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [resolvingIds, setResolvingIds] = useState<Set<number>>(new Set());

  // Состояние подтверждения закрытия инцидента
  const [incidentToResolve, setIncidentToResolve] = useState<DashboardIncidentRow | null>(null);

  // Состояние инспектора сбоев выбранного магазина (UX Drill-Down)
  const [inspectedShopName, setInspectedShopName] = useState<string | null>(null);

  // Фильтры во вкладке «Лента инцидентов»
  const [incidentSearchQuery, setIncidentSearchQuery] = useState('');
  const [selectedShopFilter, setSelectedShopFilter] = useState('ALL');

  // Поиск во вкладке «Все магазины»
  const [assetSearchQuery, setAssetSearchQuery] = useState('');

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

  // Первоначальная загрузка
  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch('/api/v1/dashboard/data', { cache: 'no-store' });
        if (res.ok && !ignore) {
          const data = await res.json();
          setIncidents(data.incidents || []);
          setWorkplaces(data.workplaces || []);
        }
      } catch (err) {
        console.error('Failed to load NOC dashboard data', err);
      } finally {
        if (!ignore) {
          setLoading(false);
          setRefreshing(false);
          setCountdown(REFRESH_INTERVAL_SECONDS);
        }
      }
    }
    load();
    return () => {
      ignore = true;
    };
  }, []);

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

  // Закрытие модальных окон по клавише Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (incidentToResolve) {
          setIncidentToResolve(null);
        } else if (inspectedShopName) {
          setInspectedShopName(null);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [incidentToResolve, inspectedShopName]);

  // Копирование в буфер обмена с временной индикацией
  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey(null);
    }, 2000);
  };

  // Фактическое закрытие инцидента («Починено») после подтверждения
  const executeResolve = async (incidentId: number) => {
    setResolvingIds((prev) => new Set(prev).add(incidentId));
    setIncidentToResolve(null);

    // Оптимистичное удаление из локального стейта
    setIncidents((prev) => prev.filter((item) => item.id !== incidentId));

    try {
      const res = await fetch(`/api/v1/incidents/${incidentId}/resolve`, {
        method: 'POST',
      });
      if (!res.ok) {
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

  // Список уникальных магазинов с активными сбоями для выпадающего списка
  const incidentShopOptions = useMemo(() => {
    const countsMap = new Map<string, number>();
    for (const inc of incidents) {
      countsMap.set(inc.shop_name, (countsMap.get(inc.shop_name) || 0) + 1);
    }
    return Array.from(countsMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [incidents]);

  // Фильтрация инцидентов на лету в основной ленте
  const filteredIncidents = useMemo(() => {
    return incidents.filter((inc) => {
      if (selectedShopFilter !== 'ALL' && inc.shop_name !== selectedShopFilter) {
        return false;
      }
      if (incidentSearchQuery.trim()) {
        const q = incidentSearchQuery.toLowerCase().trim();
        const matchesShop = inc.shop_name.toLowerCase().includes(q);
        const matchesWorkplace = inc.workplace_name.toLowerCase().includes(q);
        const matchesType = inc.error_type.toLowerCase().includes(q);
        const matchesRaw = inc.raw_error.toLowerCase().includes(q);
        const matchesDiagnosis = inc.ai_diagnosis?.toLowerCase().includes(q) ?? false;
        if (!matchesShop && !matchesWorkplace && !matchesType && !matchesRaw && !matchesDiagnosis) {
          return false;
        }
      }
      return true;
    });
  }, [incidents, selectedShopFilter, incidentSearchQuery]);

  // Инциденты и кассы для выбранного в инспекторе магазина
  const inspectedData = useMemo(() => {
    if (!inspectedShopName) return { shopIncidents: [], shopWorkplaces: [] };
    const shopIncidents = incidents.filter(
      (inc) => inc.shop_name === inspectedShopName && inc.status === 'ACTIVE'
    );
    const shopWorkplaces = workplaces.filter((wp) => wp.shop_name === inspectedShopName);
    return { shopIncidents, shopWorkplaces };
  }, [incidents, workplaces, inspectedShopName]);

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
    if (!assetSearchQuery.trim()) return workplaces;
    const q = assetSearchQuery.toLowerCase().trim();
    return workplaces.filter(
      (w) =>
        w.shop_name.toLowerCase().includes(q) ||
        w.workplace_name.toLowerCase().includes(q) ||
        (w.remote_id && w.remote_id.toLowerCase().includes(q))
    );
  }, [workplaces, assetSearchQuery]);

  return (
    <div className="min-h-screen bg-black text-zinc-100 flex flex-col font-sans">
      {/* 1. Верхняя панель управления NOC */}
      <header className="sticky top-0 z-40 bg-zinc-950 border-b border-zinc-800 px-4 md:px-6 py-2.5">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded border border-zinc-700 bg-zinc-900 flex items-center justify-center text-zinc-300">
              <Monitor className="w-4 h-4" />
            </div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm md:text-base font-semibold tracking-tight text-white font-mono">
                1C_NOC_HUB
              </h1>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-950/60 border border-emerald-800 text-emerald-400">
                SYNC_OK
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 self-end sm:self-center font-mono text-xs">
            {incidents.length > 0 && (
              <div className="flex items-center gap-1.5 bg-red-950/60 border border-red-800 text-red-300 font-semibold px-2.5 py-1 rounded">
                <Flame className="w-3.5 h-3.5 text-red-400" />
                <span>ACTIVE: {incidents.length}</span>
              </div>
            )}

            <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 px-2.5 py-1 rounded text-zinc-400">
              <Clock className="w-3 h-3 text-zinc-500" />
              <span>TTL {countdown}s</span>
            </div>

            <button
              onClick={() => fetchData()}
              disabled={refreshing}
              className="p-1.5 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 disabled:opacity-50 cursor-pointer"
              title="Обновить вручную"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'text-red-400' : ''}`} />
            </button>
          </div>
        </div>

        {/* 2. Навигационные вкладки */}
        <div className="max-w-7xl mx-auto mt-2.5 flex border-b border-zinc-800 text-xs font-mono">
          <button
            onClick={() => setActiveTab('incidents')}
            className={`pb-2 px-3 border-b-2 flex items-center gap-2 cursor-pointer ${
              activeTab === 'incidents'
                ? 'border-red-500 text-white font-bold'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
            <span>INCIDENTS</span>
            {incidents.length > 0 && (
              <span className="px-1 py-0.2 rounded bg-red-950 text-red-300 border border-red-800 text-[10px]">
                {incidents.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('assets')}
            className={`pb-2 px-3 border-b-2 flex items-center gap-2 cursor-pointer ${
              activeTab === 'assets'
                ? 'border-red-500 text-white font-bold'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Monitor className="w-3.5 h-3.5 text-zinc-400" />
            <span>ASSETS ({workplaces.length})</span>
          </button>
        </div>
      </header>

      {/* 3. Основная контентная область */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 md:px-6 py-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-500 space-y-2 font-mono text-xs">
            <RefreshCw className="w-6 h-6 text-zinc-400" />
            <p>CONNECTING_TO_STORAGE_DB...</p>
          </div>
        ) : activeTab === 'incidents' ? (
          /* =========================================================================
             ВКЛАДКА 1: ЛЕНТА ИНЦИДЕНТОВ
             ========================================================================= */
          <div className="space-y-3">
            {/* Панель фильтрации и поиска по инцидентам */}
            {incidents.length > 0 && (
              <div className="bg-zinc-900 border border-zinc-800 rounded p-2.5 space-y-2">
                <div className="flex flex-col md:flex-row md:items-center gap-2">
                  {/* Поле живого поиска */}
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
                    <input
                      type="text"
                      placeholder="Поиск по магазину, кассе или ошибке..."
                      value={incidentSearchQuery}
                      onChange={(e) => setIncidentSearchQuery(e.target.value)}
                      className="w-full bg-black border border-zinc-800 rounded pl-8 pr-7 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700 font-sans"
                    />
                    {incidentSearchQuery && (
                      <button
                        onClick={() => setIncidentSearchQuery('')}
                        className="absolute right-2.5 top-2 text-zinc-500 hover:text-zinc-300 cursor-pointer"
                        title="Очистить"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Выпадающий список магазинов */}
                  <div className="relative min-w-[220px]">
                    <select
                      value={selectedShopFilter}
                      onChange={(e) => setSelectedShopFilter(e.target.value)}
                      className="w-full bg-black border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-zinc-700 cursor-pointer appearance-none pr-7 font-mono"
                    >
                      <option value="ALL">ALL_SHOPS ({incidents.length})</option>
                      {incidentShopOptions.map(([shopName, count]) => (
                        <option key={shopName} value={shopName}>
                          {shopName} ({count})
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 text-zinc-500 absolute right-2.5 top-2.5 pointer-events-none" />
                  </div>
                </div>

                {/* Индикатор результатов и сброс фильтров */}
                <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400">
                  <div className="flex items-center gap-1.5">
                    <Filter className="w-3 h-3 text-zinc-500" />
                    <span>
                      MATCHED: <strong className="text-white">{filteredIncidents.length}</strong> / {incidents.length}
                    </span>
                  </div>

                  {(incidentSearchQuery || selectedShopFilter !== 'ALL') && (
                    <button
                      onClick={() => {
                        setIncidentSearchQuery('');
                        setSelectedShopFilter('ALL');
                      }}
                      className="text-red-400 hover:text-red-300 underline cursor-pointer"
                    >
                      RESET_FILTERS
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Состояния отображения инцидентов */}
            {incidents.length === 0 ? (
              <div className="bg-zinc-900 border border-zinc-800 rounded p-10 text-center flex flex-col items-center justify-center space-y-2">
                <div className="w-10 h-10 rounded border border-emerald-800 bg-emerald-950/30 flex items-center justify-center text-emerald-400">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white font-mono">STATUS: NO_ACTIVE_INCIDENTS</h3>
                  <p className="text-zinc-500 text-xs mt-0.5">
                    Все кассовые узлы торговой сети функционируют в штатном режиме.
                  </p>
                </div>
              </div>
            ) : filteredIncidents.length === 0 ? (
              <div className="bg-zinc-900 border border-zinc-800 rounded p-6 text-center space-y-2">
                <AlertCircle className="w-6 h-6 text-zinc-500 mx-auto" />
                <p className="text-xs text-zinc-400 font-mono">NO_MATCHING_INCIDENTS</p>
                <button
                  onClick={() => {
                    setIncidentSearchQuery('');
                    setSelectedShopFilter('ALL');
                  }}
                  className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs font-mono text-zinc-300 hover:text-white cursor-pointer"
                >
                  RESET_SEARCH
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2.5">
                {filteredIncidents.map((incident) => {
                  const isResolving = resolvingIds.has(incident.id);
                  const isAnyDesk = incident.remote_type === 'ANYDESK' && Boolean(incident.remote_id);
                  const isRuDesktop = incident.remote_type === 'RUDESKTOP' && Boolean(incident.remote_id);

                  return (
                    <article
                      key={incident.id}
                      className="bg-zinc-900 border border-zinc-800 rounded p-3.5 space-y-2.5"
                    >
                      {/* Шапка карточки */}
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 pb-2 border-b border-zinc-800">
                        <div>
                          <div className="flex items-center gap-1.5 font-mono text-xs">
                            <span
                              className={`text-[10px] uppercase font-bold px-1.5 py-0.2 rounded border ${
                                incident.severity === 'WARN'
                                  ? 'bg-amber-950/40 border-amber-800/80 text-amber-300'
                                  : 'bg-red-950/40 border-red-800/80 text-red-300'
                              }`}
                            >
                              {incident.severity || 'ERROR'}
                            </span>
                            <span className="text-zinc-500">#{incident.id}</span>
                            <span className="px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-300 text-[10px]">
                              OCCURRENCES: {incident.occurrences_count}
                            </span>
                          </div>
                          <h2 className="text-sm font-bold text-white mt-1">
                            {incident.shop_name} — {incident.workplace_name}
                          </h2>
                          <p className="text-xs font-mono text-red-300 mt-0.5">
                            {incident.error_type}
                          </p>
                        </div>

                        {/* Кнопки быстрого удаленного доступа */}
                        <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap font-mono text-xs">
                          {isAnyDesk && (
                            <>
                              <a
                                href={`anydesk://${incident.remote_id}`}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-red-900 hover:bg-red-800 text-white font-semibold border border-red-700"
                              >
                                <ExternalLink className="w-3 h-3" />
                                <span>ANYDESK: {incident.remote_id}</span>
                              </a>
                              <button
                                onClick={() => copyToClipboard(incident.remote_id!, `desk-${incident.id}`)}
                                className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700 cursor-pointer"
                                title="Скопировать AnyDesk ID"
                              >
                                {copiedKey === `desk-${incident.id}` ? (
                                  <Check className="w-3 h-3 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                              </button>
                            </>
                          )}

                          {isRuDesktop && (
                            <button
                              onClick={() => copyToClipboard(incident.remote_id!, `rudesk-${incident.id}`)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 cursor-pointer"
                            >
                              {copiedKey === `rudesk-${incident.id}` ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                              <span>RUDESK: {incident.remote_id}</span>
                            </button>
                          )}

                          {!isAnyDesk && !isRuDesktop && (
                            <span className="text-[11px] text-amber-400 bg-amber-950/30 border border-amber-800/60 px-2 py-0.5 rounded">
                              NO_REMOTE
                            </span>
                          )}

                          {/* Кнопка открытия подтверждения закрытия */}
                          <button
                            onClick={() => setIncidentToResolve(incident)}
                            disabled={isResolving}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-900 hover:bg-emerald-800 text-emerald-100 font-semibold border border-emerald-700 disabled:opacity-50 cursor-pointer"
                          >
                            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                            <span>{isResolving ? 'RESOLVING...' : 'RESOLVE'}</span>
                          </button>
                        </div>
                      </div>

                      {/* Блок AI-Triage (Диагноз и Чеклист) */}
                      {incident.ai_diagnosis && (
                        <div className="bg-black border-l-2 border-l-red-500 border border-zinc-800 rounded-r p-2.5 space-y-1 text-xs">
                          <div className="flex items-center gap-1 text-red-400 font-mono font-bold uppercase text-[10px]">
                            <Sparkles className="w-3 h-3" />
                            <span>AI_TRIAGE_DIAGNOSIS</span>
                          </div>
                          <div className="text-zinc-200 font-medium">
                            {incident.ai_diagnosis}
                          </div>
                          {incident.ai_actions && (
                            <div className="pt-1 mt-1 border-t border-zinc-800 font-mono text-[11px] text-zinc-400">
                              <pre className="whitespace-pre-wrap leading-relaxed font-mono">
                                {incident.ai_actions}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Технический сырой стек ошибки */}
                      <details className="group text-xs">
                        <summary className="cursor-pointer font-mono text-zinc-500 hover:text-zinc-300 flex items-center gap-1 list-none select-none text-[11px]">
                          <ChevronDown className="w-3 h-3 group-open:rotate-180" />
                          <span>RAW_ERROR_STACK</span>
                        </summary>
                        <div className="mt-1.5 p-2 bg-black rounded border border-zinc-800 font-mono text-[11px] text-red-300/80 whitespace-pre-wrap overflow-x-auto">
                          {incident.raw_error}
                        </div>
                      </details>

                      {/* Футер карточки с информативным относительным временем */}
                      <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 pt-0.5">
                        <span title={formatExactTime(incident.created_at)}>
                          FIRST: {formatRelativeTime(incident.created_at)}
                        </span>
                        <span title={formatExactTime(incident.last_occurred_at)}>
                          LAST: {formatRelativeTime(incident.last_occurred_at)}
                        </span>
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
          <div className="space-y-3">
            {/* Метрики */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
              <div className="bg-zinc-900 border border-zinc-800 p-2.5 rounded">
                <span className="text-[10px] text-zinc-500 uppercase">TOTAL_ASSETS</span>
                <div className="text-lg font-bold text-white mt-0.5">{stats.total}</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 p-2.5 rounded">
                <span className="text-[10px] text-emerald-400 uppercase">ONLINE</span>
                <div className="text-lg font-bold text-emerald-400 mt-0.5">{stats.online}</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 p-2.5 rounded">
                <span className="text-[10px] text-zinc-400 uppercase">OFFLINE (&gt;15m)</span>
                <div className="text-lg font-bold text-zinc-300 mt-0.5">{stats.offline}</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 p-2.5 rounded">
                <span className="text-[10px] text-amber-400 uppercase">NO_REMOTE</span>
                <div className="text-lg font-bold text-amber-400 mt-0.5">{stats.noRemote}</div>
              </div>
            </div>

            {/* Живой поиск по реестру */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Поиск по названию магазина, кассе или номеру AnyDesk/RuDesktop..."
                value={assetSearchQuery}
                onChange={(e) => setAssetSearchQuery(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded pl-8 pr-7 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700 font-sans"
              />
              {assetSearchQuery && (
                <button
                  onClick={() => setAssetSearchQuery('')}
                  className="absolute right-2.5 top-2 text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  title="Очистить"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Реестр рабочих мест */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {filteredWorkplaces.map((wp) => {
                const hasRemote = Boolean(wp.remote_id) && wp.remote_type !== 'NONE';

                return (
                  <div
                    key={wp.id}
                    onClick={() => setInspectedShopName(wp.shop_name)}
                    className="bg-zinc-900 border border-zinc-800 rounded p-3 space-y-2 hover:border-zinc-700 flex flex-col justify-between cursor-pointer group"
                  >
                    <div>
                      {/* Информативный статус контакта и инциденты */}
                      <div className="flex items-center justify-between text-xs font-mono">
                        <div>
                          {wp.is_online ? (
                            <span
                              className="text-emerald-400 flex items-center gap-1.5 text-[11px]"
                              title={formatExactTime(wp.last_seen)}
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                              <span>{formatRelativeTime(wp.last_seen)}</span>
                            </span>
                          ) : (
                            <span
                              className="text-zinc-500 flex items-center gap-1.5 text-[11px]"
                              title={formatExactTime(wp.last_seen)}
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-zinc-600"></span>
                              <span>{formatRelativeTime(wp.last_seen)}</span>
                            </span>
                          )}
                        </div>

                        {/* Кликабельный бейдж ошибок с вызовом досье */}
                        <div className="flex items-center gap-1">
                          {wp.active_incidents_count > 0 ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setInspectedShopName(wp.shop_name);
                              }}
                              className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-red-950/80 border border-red-800 text-red-300 font-bold flex items-center gap-1 hover:bg-red-900 cursor-pointer"
                              title="Открыть досье инцидентов"
                            >
                              <Flame className="w-3 h-3 text-red-400" />
                              <span>{wp.active_incidents_count} ERR</span>
                            </button>
                          ) : (
                            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-950/40 border border-emerald-800/60 text-emerald-400">
                              OK
                            </span>
                          )}

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setInspectedShopName(wp.shop_name);
                            }}
                            className="p-1 text-zinc-500 hover:text-zinc-200 cursor-pointer"
                            title="Открыть лог инцидентов"
                          >
                            <FileText className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      {/* Название */}
                      <h3 className="font-bold text-white text-xs mt-1.5 group-hover:text-red-300 flex items-center justify-between">
                        <span>{wp.shop_name}</span>
                        <ArrowRight className="w-3 h-3 opacity-0 group-hover:opacity-100 text-zinc-400" />
                      </h3>
                      <p className="text-[11px] text-zinc-400 font-mono">{wp.workplace_name}</p>

                      {/* Параметры удаленного доступа */}
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="mt-2 p-1.5 bg-black rounded border border-zinc-800/80 space-y-1 cursor-default text-[11px] font-mono"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-500">{wp.remote_type}:</span>
                          {hasRemote ? (
                            <div className="flex items-center gap-1">
                              {wp.remote_type === 'ANYDESK' ? (
                                <a
                                  href={`anydesk://${wp.remote_id}`}
                                  className="text-red-400 hover:underline flex items-center gap-0.5"
                                >
                                  {wp.remote_id}
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                              ) : (
                                <span className="text-zinc-200">{wp.remote_id}</span>
                              )}
                              <button
                                onClick={() => copyToClipboard(wp.remote_id!, `wp-remote-${wp.id}`)}
                                className="p-0.5 hover:text-white text-zinc-500 cursor-pointer"
                                title="Скопировать ID"
                              >
                                {copiedKey === `wp-remote-${wp.id}` ? (
                                  <Check className="w-2.5 h-2.5 text-emerald-400" />
                                ) : (
                                  <Copy className="w-2.5 h-2.5" />
                                )}
                              </button>
                            </div>
                          ) : (
                            <span className="text-amber-400 text-[10px]">NONE</span>
                          )}
                        </div>

                        {/* Кнопка копирования пароля поддержки */}
                        <div className="flex items-center justify-between pt-0.5 border-t border-zinc-800 text-[10px]">
                          <span className="text-zinc-500">PASS:</span>
                          <button
                            onClick={() => copyToClipboard(SUPPORT_PASSWORD, `wp-pass-${wp.id}`)}
                            className="inline-flex items-center gap-0.5 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                            title="Скопировать пароль"
                          >
                            <Key className="w-2.5 h-2.5 text-amber-400" />
                            <span>
                              {copiedKey === `wp-pass-${wp.id}` ? 'COPIED' : 'COPY'}
                            </span>
                          </button>
                        </div>
                      </div>

                      {/* Системные данные */}
                      {wp.system_info && (
                        <div className="flex flex-wrap gap-1 mt-1.5 text-[9px] font-mono">
                          {Boolean(wp.system_info.platform_version) && (
                            <span className="px-1 py-0.2 rounded bg-zinc-800 text-zinc-300">
                              1С {String(wp.system_info.platform_version)}
                            </span>
                          )}
                          {Boolean(wp.system_info.ram_gb) && (
                            <span className="px-1 py-0.2 rounded bg-zinc-800 text-zinc-300 flex items-center gap-0.5">
                              <Cpu className="w-2 h-2" />
                              {String(wp.system_info.ram_gb)}G
                            </span>
                          )}
                          {Boolean(wp.system_info.os) && (
                            <span className="px-1 py-0.2 rounded bg-zinc-800 text-zinc-300 truncate max-w-[110px]">
                              {String(wp.system_info.os)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="text-[10px] font-mono text-zinc-500 pt-1.5 border-t border-zinc-800 flex items-center justify-between">
                      <span title={formatExactTime(wp.last_seen)}>
                        SEEN: {formatRelativeTime(wp.last_seen)}
                      </span>
                      <span className="text-zinc-400 hover:text-white">DETAILS &rarr;</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>

      {/* 4. Модальное окно инспектора сбоев точки («Досье точки» — UX Drill-Down) */}
      {inspectedShopName && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-black/85">
          <div
            className="bg-zinc-900 border border-zinc-700 rounded max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden"
            role="dialog"
            aria-modal="true"
          >
            {/* Шапка модалки инспектора */}
            <div className="p-3.5 border-b border-zinc-800 flex items-start justify-between bg-black">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono uppercase px-1.5 py-0.2 rounded bg-red-950 border border-red-800 text-red-300 font-bold">
                    SHOP_DOSSIER
                  </span>
                  <h2 className="text-sm font-bold text-white font-mono">{inspectedShopName}</h2>
                </div>
                <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-400 flex-wrap">
                  <span>WORKPLACES: {inspectedData.shopWorkplaces.length}</span>
                  <span>•</span>
                  <span>
                    INCIDENTS:{' '}
                    <strong className={inspectedData.shopIncidents.length > 0 ? 'text-red-400' : 'text-emerald-400'}>
                      {inspectedData.shopIncidents.length}
                    </strong>
                  </span>
                  <span>•</span>
                  <button
                    onClick={() => copyToClipboard(SUPPORT_PASSWORD, 'inspect-modal-pass')}
                    className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                  >
                    <Key className="w-2.5 h-2.5 text-amber-400" />
                    <span>{copiedKey === 'inspect-modal-pass' ? 'COPIED' : 'SUPPORT_PASS'}</span>
                  </button>
                </div>
              </div>

              <button
                onClick={() => setInspectedShopName(null)}
                className="text-zinc-400 hover:text-white p-1 rounded hover:bg-zinc-800 cursor-pointer"
                title="Закрыть (Esc)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Тело модалки: список инцидентов точки */}
            <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5">
              {inspectedData.shopIncidents.length === 0 ? (
                <div className="bg-black border border-zinc-800 rounded p-8 text-center flex flex-col items-center justify-center space-y-2">
                  <div className="w-8 h-8 rounded border border-emerald-800 bg-emerald-950/30 flex items-center justify-center text-emerald-400">
                    <ShieldCheck className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-white font-mono">STATUS: NO_ACTIVE_INCIDENTS</h3>
                    <p className="text-zinc-500 text-[11px] mt-0.5 max-w-sm mx-auto">
                      Все кассы торговой точки «{inspectedShopName}» работают в штатном режиме.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {inspectedData.shopIncidents.map((incident) => {
                    const isResolving = resolvingIds.has(incident.id);
                    const isAnyDesk = incident.remote_type === 'ANYDESK' && Boolean(incident.remote_id);
                    const isRuDesktop = incident.remote_type === 'RUDESKTOP' && Boolean(incident.remote_id);

                    return (
                      <div
                        key={incident.id}
                        className="bg-black border border-zinc-800 rounded p-3 space-y-2 text-xs"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 pb-1.5 border-b border-zinc-800">
                          <div>
                            <div className="flex items-center gap-1.5 font-mono">
                              <span
                                className={`text-[10px] uppercase font-bold px-1.5 py-0.2 rounded border ${
                                  incident.severity === 'WARN'
                                    ? 'bg-amber-950/40 border-amber-800/80 text-amber-300'
                                    : 'bg-red-950/40 border-red-800/80 text-red-300'
                                }`}
                              >
                                {incident.severity || 'ERROR'}
                              </span>
                              <span className="font-bold text-white">
                                {incident.workplace_name}
                              </span>
                              <span className="text-zinc-500 text-[10px]">
                                (x{incident.occurrences_count})
                              </span>
                            </div>
                            <p className="text-[11px] font-mono text-red-300 mt-0.5">
                              {incident.error_type}
                            </p>
                          </div>

                          <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap font-mono text-xs">
                            {isAnyDesk && (
                              <a
                                href={`anydesk://${incident.remote_id}`}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-900 hover:bg-red-800 text-white font-semibold border border-red-700 text-[11px]"
                              >
                                <ExternalLink className="w-2.5 h-2.5" />
                                <span>ANYDESK: {incident.remote_id}</span>
                              </a>
                            )}
                            {isRuDesktop && (
                              <button
                                onClick={() => copyToClipboard(incident.remote_id!, `modal-ru-${incident.id}`)}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 text-[11px] cursor-pointer"
                              >
                                <span>RUDESK: {incident.remote_id}</span>
                              </button>
                            )}
                            <button
                              onClick={() => setIncidentToResolve(incident)}
                              disabled={isResolving}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-900 hover:bg-emerald-800 text-emerald-100 font-semibold border border-emerald-700 disabled:opacity-50 cursor-pointer text-[11px]"
                            >
                              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                              <span>RESOLVE</span>
                            </button>
                          </div>
                        </div>

                        {/* AI-Triage в инспекторе */}
                        {incident.ai_diagnosis && (
                          <div className="bg-zinc-950 border-l-2 border-l-red-500 border border-zinc-800 rounded-r p-2 space-y-1 text-[11px]">
                            <div className="flex items-center gap-1 text-red-400 font-mono font-bold uppercase text-[10px]">
                              <Sparkles className="w-2.5 h-2.5" />
                              <span>AI_DIAGNOSIS</span>
                            </div>
                            <div className="text-zinc-200">{incident.ai_diagnosis}</div>
                            {incident.ai_actions && (
                              <pre className="text-zinc-400 font-mono whitespace-pre-wrap text-[10px] pt-1 mt-1 border-t border-zinc-800">
                                {incident.ai_actions}
                              </pre>
                            )}
                          </div>
                        )}

                        {/* Спойлер сырого лога */}
                        <details className="group text-xs">
                          <summary className="cursor-pointer font-mono text-zinc-500 hover:text-zinc-300 flex items-center gap-1 list-none select-none text-[10px]">
                            <ChevronDown className="w-2.5 h-2.5 group-open:rotate-180" />
                            <span>RAW_LOG</span>
                          </summary>
                          <div className="mt-1 p-2 bg-black rounded border border-zinc-800 font-mono text-[10px] text-red-300/80 whitespace-pre-wrap overflow-x-auto">
                            {incident.raw_error}
                          </div>
                        </details>

                        <div className="text-[9px] font-mono text-zinc-500 flex items-center justify-between pt-0.5">
                          <span title={formatExactTime(incident.created_at)}>
                            FIRST: {formatRelativeTime(incident.created_at)}
                          </span>
                          <span title={formatExactTime(incident.last_occurred_at)}>
                            LAST: {formatRelativeTime(incident.last_occurred_at)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Подвал модалки инспектора */}
            <div className="p-3 border-t border-zinc-800 bg-black flex items-center justify-between font-mono text-xs">
              <button
                onClick={() => {
                  const shopToFilter = inspectedShopName;
                  setInspectedShopName(null);
                  setSelectedShopFilter(shopToFilter);
                  setActiveTab('incidents');
                }}
                className="inline-flex items-center gap-1 text-red-400 hover:text-red-300 cursor-pointer"
              >
                <span>OPEN_IN_INCIDENTS_TAB</span>
                <ExternalLink className="w-3 h-3" />
              </button>

              <button
                onClick={() => setInspectedShopName(null)}
                className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white cursor-pointer"
              >
                CLOSE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. Модальное окно подтверждения закрытия инцидента */}
      {incidentToResolve && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85">
          <div
            className="bg-zinc-900 border border-zinc-700 rounded max-w-sm w-full p-4 space-y-3 font-mono"
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded border border-emerald-800 bg-emerald-950/40 flex items-center justify-center text-emerald-400">
                  <CheckCircle2 className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-xs font-bold text-white uppercase">
                    CONFIRM_RESOLVE
                  </h3>
                  <p className="text-[10px] text-zinc-500">Снятие инцидента с монитора</p>
                </div>
              </div>
              <button
                onClick={() => setIncidentToResolve(null)}
                className="text-zinc-500 hover:text-white p-1 rounded hover:bg-zinc-800 cursor-pointer"
                title="Отмена (Esc)"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="bg-black rounded p-2.5 border border-zinc-800 text-xs text-zinc-300 space-y-1.5">
              <p className="font-sans leading-relaxed">
                Закрыть инцидент на точке <strong className="text-white">{incidentToResolve.shop_name}</strong>{' '}
                ({incidentToResolve.workplace_name})?
              </p>
              <div className="pt-1.5 border-t border-zinc-800 text-[10px] text-zinc-500">
                EVENT: <span className="text-red-300">{incidentToResolve.error_type}</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-0.5 text-xs">
              <button
                type="button"
                onClick={() => setIncidentToResolve(null)}
                className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white cursor-pointer"
              >
                CANCEL
              </button>
              <button
                type="button"
                onClick={() => executeResolve(incidentToResolve.id)}
                className="px-3 py-1 rounded bg-emerald-900 hover:bg-emerald-800 text-emerald-100 font-semibold border border-emerald-700 cursor-pointer flex items-center gap-1"
              >
                <Check className="w-3 h-3 text-emerald-400" />
                <span>RESOLVE</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
