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
  History,
} from 'lucide-react';
import type { DashboardIncidentRow, DashboardWorkplaceRow } from '@/app/api/v1/dashboard/data/route';

const SUPPORT_PASSWORD = 'SuperSupportPass2026!';
const REFRESH_INTERVAL_SECONDS = 20;

/**
 * Склонение русских существительных по числам
 */
function pluralizeRu(count: number, one: string, twoToFour: string, many: string): string {
  const abs = Math.abs(count) % 100;
  const rem = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (rem > 1 && rem < 5) return twoToFour;
  if (rem === 1) return one;
  return many;
}

/**
 * Форматирование времени относительно текущего момента:
 * - < 10 сек  -> "только что"
 * - < 60 сек  -> "N сек назад"
 * - < 60 мин  -> "N мин назад"
 * - < 24 ч    -> "N ч назад"
 * - >= 24 ч   -> "N дн назад"
 */
function formatRelativeTime(dateString: string | null | undefined): string {
  if (!dateString) return 'нет данных';
  const timestamp = new Date(dateString).getTime();
  if (Number.isNaN(timestamp)) return 'нет данных';

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
  if (Number.isNaN(d.getTime())) return 'нет данных';
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

  // Состояние подтверждения закрытия инцидента («Починено»)
  const [incidentToResolve, setIncidentToResolve] = useState<DashboardIncidentRow | null>(null);

  // Состояние инспектора точки («Досье магазина» — UX Drill-Down + Audit Trail)
  const [inspectedShopName, setInspectedShopName] = useState<string | null>(null);
  const [inspectedModalFilter, setInspectedModalFilter] = useState<'ALL' | 'ACTIVE' | 'RESOLVED'>('ALL');

  // Фильтры во вкладке «Лента инцидентов»
  const [incidentStatusFilter, setIncidentStatusFilter] = useState<'ALL' | 'ACTIVE' | 'RESOLVED'>('ACTIVE');
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
      console.error('Не удалось загрузить данные NOC дашборда', err);
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
        console.error('Не удалось загрузить данные NOC дашборда', err);
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

  // Автообновление по таймеру
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

  // Закрытие модальных окон по Escape
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

  // Копирование в буфер обмена
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

    const nowIso = new Date().toISOString();

    // Оптимистичное обновление статуса в локальном стейте
    setIncidents((prev) =>
      prev.map((item) =>
        item.id === incidentId
          ? { ...item, status: 'RESOLVED', resolved_at: nowIso }
          : item
      )
    );

    // Снижаем счетчик активных сбоев кассы
    const target = incidents.find((i) => i.id === incidentId);
    if (target) {
      setWorkplaces((prev) =>
        prev.map((wp) => {
          if (wp.id === target.workplace_id) {
            return {
              ...wp,
              active_incidents_count: Math.max(0, wp.active_incidents_count - 1),
            };
          }
          return wp;
        })
      );
    }

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

  // Подсчет активных инцидентов
  const activeIncidents = useMemo(() => {
    return incidents.filter((i) => i.status === 'ACTIVE');
  }, [incidents]);

  const resolvedIncidents = useMemo(() => {
    return incidents.filter((i) => i.status === 'RESOLVED');
  }, [incidents]);

  // Список уникальных магазинов с активными сбоями для фильтра
  const incidentShopOptions = useMemo(() => {
    const countsMap = new Map<string, { active: number; total: number }>();
    for (const inc of incidents) {
      const cur = countsMap.get(inc.shop_name) || { active: 0, total: 0 };
      cur.total += 1;
      if (inc.status === 'ACTIVE') cur.active += 1;
      countsMap.set(inc.shop_name, cur);
    }
    return Array.from(countsMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [incidents]);

  // Фильтрация инцидентов в основной ленте
  const filteredIncidents = useMemo(() => {
    return incidents.filter((inc) => {
      // 1. Фильтр статуса
      if (incidentStatusFilter === 'ACTIVE' && inc.status !== 'ACTIVE') return false;
      if (incidentStatusFilter === 'RESOLVED' && inc.status !== 'RESOLVED') return false;

      // 2. Фильтр по магазину
      if (selectedShopFilter !== 'ALL' && inc.shop_name !== selectedShopFilter) {
        return false;
      }

      // 3. Поисковый запрос
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
  }, [incidents, incidentStatusFilter, selectedShopFilter, incidentSearchQuery]);

  // Данные для открытого досье магазина (UX Drill-Down + 14-Day Audit Trail)
  const inspectedData = useMemo(() => {
    if (!inspectedShopName) {
      return { allIncidents: [], activeIncidents: [], resolvedIncidents: [], shopWorkplaces: [] };
    }
    const allIncidents = incidents.filter((inc) => inc.shop_name === inspectedShopName);
    const activeShopIncidents = allIncidents.filter((inc) => inc.status === 'ACTIVE');
    const resolvedShopIncidents = allIncidents.filter((inc) => inc.status === 'RESOLVED');
    const shopWorkplaces = workplaces.filter((wp) => wp.shop_name === inspectedShopName);

    return {
      allIncidents,
      activeIncidents: activeShopIncidents,
      resolvedIncidents: resolvedShopIncidents,
      shopWorkplaces,
    };
  }, [incidents, workplaces, inspectedShopName]);

  // Отфильтрованные инциденты внутри открытого досье
  const displayedInspectedIncidents = useMemo(() => {
    if (inspectedModalFilter === 'ACTIVE') return inspectedData.activeIncidents;
    if (inspectedModalFilter === 'RESOLVED') return inspectedData.resolvedIncidents;
    return inspectedData.allIncidents;
  }, [inspectedData, inspectedModalFilter]);

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
                1C NOC МОНИТОРИНГ
              </h1>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-800 text-emerald-400">
                СВЯЗЬ В НОРМЕ
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 self-end sm:self-center font-mono text-xs">
            {activeIncidents.length > 0 && (
              <div className="flex items-center gap-1.5 bg-red-950/60 border border-red-800 text-red-300 font-semibold px-2.5 py-1 rounded">
                <Flame className="w-3.5 h-3.5 text-red-400" />
                <span>АКТИВНЫХ СБОЕВ: {activeIncidents.length}</span>
              </div>
            )}

            <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 px-2.5 py-1 rounded text-zinc-400">
              <Clock className="w-3 h-3 text-zinc-500" />
              <span>ОБНОВЛЕНИЕ {countdown}с</span>
            </div>

            <button
              onClick={() => fetchData()}
              disabled={refreshing}
              className="p-1.5 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 disabled:opacity-50 cursor-pointer"
              title="Обновить данные"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'text-red-400 animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* 2. Навигационные вкладки */}
        <div className="max-w-7xl mx-auto mt-2.5 flex border-b border-zinc-800 text-xs font-mono">
          <button
            onClick={() => setActiveTab('incidents')}
            className={`pb-2 px-3 border-b-2 flex items-center gap-2 cursor-pointer transition-colors ${
              activeTab === 'incidents'
                ? 'border-red-500 text-white font-bold'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
            <span>ИНЦИДЕНТЫ</span>
            {activeIncidents.length > 0 && (
              <span className="px-1.5 py-0.2 rounded bg-red-950 text-red-300 border border-red-800 text-[10px] font-bold">
                {activeIncidents.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('assets')}
            className={`pb-2 px-3 border-b-2 flex items-center gap-2 cursor-pointer transition-colors ${
              activeTab === 'assets'
                ? 'border-red-500 text-white font-bold'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Monitor className="w-3.5 h-3.5 text-zinc-400" />
            <span>ВСЕ МАГАЗИНЫ ({workplaces.length})</span>
          </button>
        </div>
      </header>

      {/* 3. Основная контентная область */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 md:px-6 py-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-500 space-y-2 font-mono text-xs">
            <RefreshCw className="w-6 h-6 text-zinc-400 animate-spin" />
            <p>ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ...</p>
          </div>
        ) : activeTab === 'incidents' ? (
          /* =========================================================================
             ВКЛАДКА 1: ЛЕНТА ИНЦИДЕНТОВ
             ========================================================================= */
          <div className="space-y-3">
            {/* Панель фильтрации и поиска по инцидентам */}
            <div className="bg-zinc-900 border border-zinc-800 rounded p-2.5 space-y-2.5">
              <div className="flex flex-col md:flex-row md:items-center gap-2">
                {/* Поле живого поиска */}
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    placeholder="Поиск по магазину, кассе или тексту ошибки..."
                    value={incidentSearchQuery}
                    onChange={(e) => setIncidentSearchQuery(e.target.value)}
                    className="w-full bg-black border border-zinc-800 rounded pl-8 pr-7 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700 font-sans"
                  />
                  {incidentSearchQuery && (
                    <button
                      onClick={() => setIncidentSearchQuery('')}
                      className="absolute right-2.5 top-2 text-zinc-500 hover:text-zinc-300 cursor-pointer"
                      title="Очистить поиск"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Выпадающий список магазинов */}
                <div className="relative min-w-[240px]">
                  <select
                    value={selectedShopFilter}
                    onChange={(e) => setSelectedShopFilter(e.target.value)}
                    className="w-full bg-black border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-zinc-700 cursor-pointer appearance-none pr-7 font-mono"
                  >
                    <option value="ALL">Все магазины ({incidents.length})</option>
                    {incidentShopOptions.map(([shopName, counts]) => (
                      <option key={shopName} value={shopName}>
                        {shopName} ({counts.active > 0 ? `${counts.active} активн.` : 'в архиве'})
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-3.5 h-3.5 text-zinc-500 absolute right-2.5 top-2.5 pointer-events-none" />
                </div>
              </div>

              {/* Переключатель статуса инцидента и сводка */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-1 border-t border-zinc-800/80 text-[11px] font-mono">
                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-500 mr-1">Статус:</span>
                  <button
                    onClick={() => setIncidentStatusFilter('ACTIVE')}
                    className={`px-2 py-0.5 rounded cursor-pointer transition-colors ${
                      incidentStatusFilter === 'ACTIVE'
                        ? 'bg-red-950/80 border border-red-800 text-red-300 font-bold'
                        : 'bg-black border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    Только активные ({activeIncidents.length})
                  </button>
                  <button
                    onClick={() => setIncidentStatusFilter('ALL')}
                    className={`px-2 py-0.5 rounded cursor-pointer transition-colors ${
                      incidentStatusFilter === 'ALL'
                        ? 'bg-zinc-800 border border-zinc-700 text-white font-bold'
                        : 'bg-black border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    Все за 14 дней ({incidents.length})
                  </button>
                  <button
                    onClick={() => setIncidentStatusFilter('RESOLVED')}
                    className={`px-2 py-0.5 rounded cursor-pointer transition-colors ${
                      incidentStatusFilter === 'RESOLVED'
                        ? 'bg-emerald-950/80 border border-emerald-800 text-emerald-300 font-bold'
                        : 'bg-black border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    Решенные ({resolvedIncidents.length})
                  </button>
                </div>

                <div className="flex items-center gap-3 text-zinc-400 self-end sm:self-auto">
                  <div className="flex items-center gap-1.5">
                    <Filter className="w-3 h-3 text-zinc-500" />
                    <span>
                      Найдено: <strong className="text-white">{filteredIncidents.length}</strong> из {incidents.length}
                    </span>
                  </div>

                  {(incidentSearchQuery || selectedShopFilter !== 'ALL' || incidentStatusFilter !== 'ACTIVE') && (
                    <button
                      onClick={() => {
                        setIncidentSearchQuery('');
                        setSelectedShopFilter('ALL');
                        setIncidentStatusFilter('ACTIVE');
                      }}
                      className="text-red-400 hover:text-red-300 underline cursor-pointer"
                    >
                      Сбросить фильтры
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Состояния отображения инцидентов */}
            {incidents.length === 0 ? (
              <div className="bg-zinc-900 border border-zinc-800 rounded p-10 text-center flex flex-col items-center justify-center space-y-2">
                <div className="w-10 h-10 rounded border border-emerald-800 bg-emerald-950/30 flex items-center justify-center text-emerald-400">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white font-mono">СТАТУС: НЕТ АКТИВНЫХ СБОЕВ</h3>
                  <p className="text-zinc-500 text-xs mt-0.5">
                    Все кассовые узлы торговой сети функционируют в штатном режиме.
                  </p>
                </div>
              </div>
            ) : filteredIncidents.length === 0 ? (
              <div className="bg-zinc-900 border border-zinc-800 rounded p-8 text-center space-y-2.5">
                <AlertCircle className="w-6 h-6 text-zinc-500 mx-auto" />
                <p className="text-xs text-zinc-300 font-mono">Инциденты по заданным условиям не найдены</p>
                <p className="text-[11px] text-zinc-500">
                  Попробуйте изменить параметры поиска или переключить статус.
                </p>
                <button
                  onClick={() => {
                    setIncidentSearchQuery('');
                    setSelectedShopFilter('ALL');
                    setIncidentStatusFilter('ALL');
                  }}
                  className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs font-mono text-zinc-200 hover:text-white cursor-pointer"
                >
                  Показать все инциденты
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2.5">
                {filteredIncidents.map((incident) => {
                  const isResolving = resolvingIds.has(incident.id);
                  const isResolved = incident.status === 'RESOLVED';
                  const isAnyDesk = incident.remote_type === 'ANYDESK' && Boolean(incident.remote_id);
                  const isRuDesktop = incident.remote_type === 'RUDESKTOP' && Boolean(incident.remote_id);

                  return (
                    <article
                      key={incident.id}
                      className={`bg-zinc-900 border rounded p-3.5 space-y-2.5 transition-colors ${
                        isResolved ? 'border-zinc-800/60 opacity-85' : 'border-zinc-800'
                      }`}
                    >
                      {/* Шапка карточки */}
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 pb-2 border-b border-zinc-800">
                        <div>
                          <div className="flex items-center gap-1.5 font-mono text-xs flex-wrap">
                            {isResolved ? (
                              <span className="text-[10px] uppercase font-bold px-1.5 py-0.2 rounded border bg-emerald-950/60 border-emerald-800 text-emerald-300 flex items-center gap-1">
                                <Check className="w-2.5 h-2.5" />
                                <span>РЕШЕНО</span>
                              </span>
                            ) : (
                              <span
                                className={`text-[10px] uppercase font-bold px-1.5 py-0.2 rounded border ${
                                  incident.severity === 'WARN'
                                    ? 'bg-amber-950/40 border-amber-800/80 text-amber-300'
                                    : 'bg-red-950/40 border-red-800/80 text-red-300'
                                }`}
                              >
                                {incident.severity === 'WARN' ? 'ПРЕДУПРЕЖДЕНИЕ' : 'КРИТИЧЕСКАЯ'}
                              </span>
                            )}

                            <span className="text-zinc-500">#{incident.id}</span>
                            <span className="px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-300 text-[10px]">
                              {incident.occurrences_count}{' '}
                              {pluralizeRu(incident.occurrences_count, 'повтор', 'повтора', 'повторов')}
                            </span>

                            {isResolved && incident.resolved_at && (
                              <span
                                className="text-[10px] text-emerald-400/90 font-mono"
                                title={formatExactTime(incident.resolved_at)}
                              >
                                • Закрыт: {formatRelativeTime(incident.resolved_at)}
                              </span>
                            )}
                          </div>

                          <h2 className="text-sm font-bold text-white mt-1">
                            {incident.shop_name} — {incident.workplace_name}
                          </h2>
                          <p
                            className={`text-xs font-mono mt-0.5 ${
                              isResolved ? 'text-zinc-400' : 'text-red-300'
                            }`}
                          >
                            {incident.error_type}
                          </p>
                        </div>

                        {/* Кнопки быстрого удаленного доступа и решения */}
                        <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap font-mono text-xs">
                          {isAnyDesk && (
                            <>
                              <a
                                href={`anydesk://${incident.remote_id}`}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-red-900 hover:bg-red-800 text-white font-semibold border border-red-700"
                                title="Подключиться через AnyDesk"
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
                              title="Скопировать номер RuDesktop"
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
                              НЕТ ANYDESK
                            </span>
                          )}

                          {/* Кнопка закрытия или отметка решено */}
                          {!isResolved ? (
                            <button
                              onClick={() => setIncidentToResolve(incident)}
                              disabled={isResolving}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-900 hover:bg-emerald-800 text-emerald-100 font-semibold border border-emerald-700 disabled:opacity-50 cursor-pointer"
                            >
                              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                              <span>{isResolving ? 'СОХРАНЕНИЕ...' : 'ПОЧИНЕНО'}</span>
                            </button>
                          ) : (
                            <div className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-800/80 text-emerald-400 border border-zinc-700 text-[11px]">
                              <Check className="w-3 h-3" />
                              <span>РЕШЕНО</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Блок AI-Triage (Диагноз и Рекомендация) */}
                      {incident.ai_diagnosis && (
                        <div className="bg-black border-l-2 border-l-red-500 border border-zinc-800 rounded-r p-2.5 space-y-1 text-xs">
                          <div className="flex items-center gap-1 text-red-400 font-mono font-bold uppercase text-[10px]">
                            <Sparkles className="w-3 h-3" />
                            <span>РЕКОМЕНДАЦИЯ ИИ (AI-TRIAGE)</span>
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

                      {/* Исходный стек ошибки */}
                      <details className="group text-xs">
                        <summary className="cursor-pointer font-mono text-zinc-500 hover:text-zinc-300 flex items-center gap-1 list-none select-none text-[11px]">
                          <ChevronDown className="w-3 h-3 group-open:rotate-180" />
                          <span>ИСХОДНЫЙ СТЕК ОШИБКИ</span>
                        </summary>
                        <div className="mt-1.5 p-2 bg-black rounded border border-zinc-800 font-mono text-[11px] text-red-300/80 whitespace-pre-wrap overflow-x-auto">
                          {incident.raw_error}
                        </div>
                      </details>

                      {/* Футер карточки с информативным относительным временем */}
                      <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 pt-0.5">
                        <span title={formatExactTime(incident.created_at)}>
                          Первое появление: {formatRelativeTime(incident.created_at)}
                        </span>
                        <span title={formatExactTime(incident.last_occurred_at)}>
                          Последнее: {formatRelativeTime(incident.last_occurred_at)}
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
             ВКЛАДКА 2: ВСЕ МАГАЗИНЫ (РЕЕСТР КАСС)
             ========================================================================= */
          <div className="space-y-3">
            {/* Метрики */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
              <div className="bg-zinc-900 border border-zinc-800 p-2.5 rounded">
                <span className="text-[10px] text-zinc-500 uppercase">ВСЕГО КАСС</span>
                <div className="text-lg font-bold text-white mt-0.5">{stats.total}</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 p-2.5 rounded">
                <span className="text-[10px] text-emerald-400 uppercase">НА СВЯЗИ</span>
                <div className="text-lg font-bold text-emerald-400 mt-0.5">{stats.online}</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 p-2.5 rounded">
                <span className="text-[10px] text-zinc-400 uppercase">НЕ В СЕТИ (&gt;15 МИН)</span>
                <div className="text-lg font-bold text-zinc-300 mt-0.5">{stats.offline}</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 p-2.5 rounded">
                <span className="text-[10px] text-amber-400 uppercase">БЕЗ ANYDESK</span>
                <div className="text-lg font-bold text-amber-400 mt-0.5">{stats.noRemote}</div>
              </div>
            </div>

            {/* Живой поиск по реестру касс */}
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

            {/* Сетка карточек рабочих мест */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {filteredWorkplaces.map((wp) => {
                const hasRemote = Boolean(wp.remote_id) && wp.remote_type !== 'NONE';

                return (
                  <div
                    key={wp.id}
                    onClick={() => {
                      setInspectedShopName(wp.shop_name);
                      setInspectedModalFilter('ALL');
                    }}
                    className="bg-zinc-900 border border-zinc-800 rounded p-3 space-y-2 hover:border-zinc-700 flex flex-col justify-between cursor-pointer group transition-colors"
                  >
                    <div>
                      {/* Информативный статус контакта и бейдж ошибок */}
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
                                setInspectedModalFilter('ACTIVE');
                              }}
                              className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-red-950/80 border border-red-800 text-red-300 font-bold flex items-center gap-1 hover:bg-red-900 cursor-pointer"
                              title="Открыть досье инцидентов"
                            >
                              <Flame className="w-3 h-3 text-red-400" />
                              <span>
                                {wp.active_incidents_count}{' '}
                                {pluralizeRu(wp.active_incidents_count, 'СБОЙ', 'СБОЯ', 'СБОЕВ')}
                              </span>
                            </button>
                          ) : (
                            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-950/40 border border-emerald-800/60 text-emerald-400">
                              В НОРМЕ
                            </span>
                          )}

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setInspectedShopName(wp.shop_name);
                              setInspectedModalFilter('ALL');
                            }}
                            className="p-1 text-zinc-500 hover:text-zinc-200 cursor-pointer"
                            title="Открыть досье магазина"
                          >
                            <FileText className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      {/* Название магазина и кассы */}
                      <h3 className="font-bold text-white text-xs mt-1.5 group-hover:text-red-300 flex items-center justify-between">
                        <span>{wp.shop_name}</span>
                        <ArrowRight className="w-3 h-3 opacity-0 group-hover:opacity-100 text-zinc-400 transition-opacity" />
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
                                  title="Открыть AnyDesk"
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
                                title="Скопировать номер"
                              >
                                {copiedKey === `wp-remote-${wp.id}` ? (
                                  <Check className="w-2.5 h-2.5 text-emerald-400" />
                                ) : (
                                  <Copy className="w-2.5 h-2.5" />
                                )}
                              </button>
                            </div>
                          ) : (
                            <span className="text-amber-400 text-[10px]">НЕТ</span>
                          )}
                        </div>

                        {/* Кнопка копирования пароля поддержки */}
                        <div className="flex items-center justify-between pt-0.5 border-t border-zinc-800 text-[10px]">
                          <span className="text-zinc-500">ПАРОЛЬ:</span>
                          <button
                            onClick={() => copyToClipboard(SUPPORT_PASSWORD, `wp-pass-${wp.id}`)}
                            className="inline-flex items-center gap-0.5 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                            title="Скопировать мастер-пароль"
                          >
                            <Key className="w-2.5 h-2.5 text-amber-400" />
                            <span>
                              {copiedKey === `wp-pass-${wp.id}` ? 'СКОПИРОВАНО' : 'СКОПИРОВАТЬ'}
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
                              {String(wp.system_info.ram_gb)} ГБ
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
                        Связь: {formatRelativeTime(wp.last_seen)}
                      </span>
                      <span className="text-zinc-400 group-hover:text-white flex items-center gap-1">
                        <span>ДОСЬЕ ТОЧКИ</span>
                        <span>&rarr;</span>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>

      {/* 4. Модальное окно инспектора точки («Досье магазина» — UX Drill-Down + 14-Day Audit Trail) */}
      {inspectedShopName && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-black/85">
          <div
            className="bg-zinc-900 border border-zinc-700 rounded max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden shadow-2xl"
            role="dialog"
            aria-modal="true"
          >
            {/* Шапка модалки инспектора */}
            <div className="p-3.5 border-b border-zinc-800 flex items-start justify-between bg-black">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono uppercase px-1.5 py-0.2 rounded bg-red-950 border border-red-800 text-red-300 font-bold">
                    ДОСЬЕ МАГАЗИНА
                  </span>
                  <h2 className="text-sm font-bold text-white font-mono">{inspectedShopName}</h2>
                </div>
                <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-400 flex-wrap">
                  <span>Касс: {inspectedData.shopWorkplaces.length}</span>
                  <span>•</span>
                  <span>
                    Активных сбоев:{' '}
                    <strong
                      className={
                        inspectedData.activeIncidents.length > 0 ? 'text-red-400' : 'text-emerald-400'
                      }
                    >
                      {inspectedData.activeIncidents.length}
                    </strong>
                  </span>
                  <span>•</span>
                  <span>В архиве (14 дней): {inspectedData.resolvedIncidents.length}</span>
                  <span>•</span>
                  <button
                    onClick={() => copyToClipboard(SUPPORT_PASSWORD, 'inspect-modal-pass')}
                    className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                    title="Скопировать пароль администратора"
                  >
                    <Key className="w-2.5 h-2.5 text-amber-400" />
                    <span>
                      {copiedKey === 'inspect-modal-pass' ? 'СКОПИРОВАНО' : 'ПАРОЛЬ АДМИНА'}
                    </span>
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

            {/* Панель вкладок аудита внутри досье */}
            <div className="px-3.5 py-2 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between text-xs font-mono">
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setInspectedModalFilter('ALL')}
                  className={`px-2.5 py-1 rounded cursor-pointer transition-colors ${
                    inspectedModalFilter === 'ALL'
                      ? 'bg-zinc-800 text-white font-bold'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Все сбои ({inspectedData.allIncidents.length})
                </button>
                <button
                  onClick={() => setInspectedModalFilter('ACTIVE')}
                  className={`px-2.5 py-1 rounded cursor-pointer transition-colors ${
                    inspectedModalFilter === 'ACTIVE'
                      ? 'bg-red-950 text-red-300 border border-red-800 font-bold'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Активные ({inspectedData.activeIncidents.length})
                </button>
                <button
                  onClick={() => setInspectedModalFilter('RESOLVED')}
                  className={`px-2.5 py-1 rounded cursor-pointer transition-colors ${
                    inspectedModalFilter === 'RESOLVED'
                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-800 font-bold'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Решенные ({inspectedData.resolvedIncidents.length})
                </button>
              </div>

              <div className="text-[10px] text-zinc-500 hidden sm:flex items-center gap-1">
                <History className="w-3 h-3 text-zinc-500" />
                <span>Глубина архива: 14 дней</span>
              </div>
            </div>

            {/* Тело модалки: список инцидентов точки */}
            <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5">
              {inspectedData.allIncidents.length === 0 ? (
                <div className="bg-black border border-zinc-800 rounded p-8 text-center flex flex-col items-center justify-center space-y-2">
                  <div className="w-8 h-8 rounded border border-emerald-800 bg-emerald-950/30 flex items-center justify-center text-emerald-400">
                    <ShieldCheck className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-white font-mono">
                      СТАТУС: СБОЕВ НЕ ЗАФИКСИРОВАНО
                    </h3>
                    <p className="text-zinc-500 text-[11px] mt-0.5 max-w-sm mx-auto">
                      За последние 14 дней на кассах магазина «{inspectedShopName}» не возникало критических ошибок.
                    </p>
                  </div>
                </div>
              ) : displayedInspectedIncidents.length === 0 ? (
                <div className="bg-black border border-zinc-800 rounded p-6 text-center space-y-1.5 font-mono text-xs">
                  <p className="text-zinc-400">В этой категории записей не найдено.</p>
                  <button
                    onClick={() => setInspectedModalFilter('ALL')}
                    className="text-red-400 hover:underline text-[11px] cursor-pointer"
                  >
                    Показать все записи ({inspectedData.allIncidents.length})
                  </button>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {/* Информационный баннер при отсутствии активных сбоев */}
                  {inspectedData.activeIncidents.length === 0 && inspectedModalFilter !== 'ACTIVE' && (
                    <div className="bg-emerald-950/40 border border-emerald-800/80 rounded p-2.5 flex items-center gap-2 text-xs font-mono text-emerald-300">
                      <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>Все текущие проблемы устранены. Ниже показан журнал решенных инцидентов.</span>
                    </div>
                  )}

                  {displayedInspectedIncidents.map((incident) => {
                    const isResolving = resolvingIds.has(incident.id);
                    const isResolved = incident.status === 'RESOLVED';
                    const isAnyDesk = incident.remote_type === 'ANYDESK' && Boolean(incident.remote_id);
                    const isRuDesktop = incident.remote_type === 'RUDESKTOP' && Boolean(incident.remote_id);

                    return (
                      <div
                        key={incident.id}
                        className={`bg-black border rounded p-3 space-y-2 text-xs transition-colors ${
                          isResolved ? 'border-zinc-800/70' : 'border-zinc-800'
                        }`}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 pb-1.5 border-b border-zinc-800">
                          <div>
                            <div className="flex items-center gap-1.5 font-mono flex-wrap">
                              {isResolved ? (
                                <span className="text-[10px] uppercase font-bold px-1.5 py-0.2 rounded border bg-emerald-950/60 border-emerald-800 text-emerald-300 flex items-center gap-1">
                                  <Check className="w-2.5 h-2.5" />
                                  <span>РЕШЕНО</span>
                                </span>
                              ) : (
                                <span
                                  className={`text-[10px] uppercase font-bold px-1.5 py-0.2 rounded border ${
                                    incident.severity === 'WARN'
                                      ? 'bg-amber-950/40 border-amber-800/80 text-amber-300'
                                      : 'bg-red-950/40 border-red-800/80 text-red-300'
                                  }`}
                                >
                                  {incident.severity === 'WARN' ? 'ПРЕДУПРЕЖДЕНИЕ' : 'В РАБОТЕ'}
                                </span>
                              )}

                              <span className="font-bold text-white">
                                {incident.workplace_name}
                              </span>
                              <span className="text-zinc-500 text-[10px]">
                                ({incident.occurrences_count}{' '}
                                {pluralizeRu(incident.occurrences_count, 'повтор', 'повтора', 'повторов')})
                              </span>

                              {isResolved && incident.resolved_at && (
                                <span
                                  className="text-[10px] text-emerald-400 font-mono"
                                  title={formatExactTime(incident.resolved_at)}
                                >
                                  • Закрыт: {formatRelativeTime(incident.resolved_at)}
                                </span>
                              )}
                            </div>

                            <p
                              className={`text-[11px] font-mono mt-0.5 ${
                                isResolved ? 'text-zinc-400' : 'text-red-300'
                              }`}
                            >
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

                            {!isResolved ? (
                              <button
                                onClick={() => setIncidentToResolve(incident)}
                                disabled={isResolving}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-900 hover:bg-emerald-800 text-emerald-100 font-semibold border border-emerald-700 disabled:opacity-50 cursor-pointer text-[11px]"
                              >
                                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                                <span>{isResolving ? 'СОХРАНЕНИЕ...' : 'ПОЧИНЕНО'}</span>
                              </button>
                            ) : (
                              <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800/80 text-emerald-400 border border-zinc-700 text-[10px]">
                                <Check className="w-2.5 h-2.5" />
                                <span>АРХИВ</span>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* AI-Triage в инспекторе */}
                        {incident.ai_diagnosis && (
                          <div className="bg-zinc-950 border-l-2 border-l-red-500 border border-zinc-800 rounded-r p-2 space-y-1 text-[11px]">
                            <div className="flex items-center gap-1 text-red-400 font-mono font-bold uppercase text-[10px]">
                              <Sparkles className="w-2.5 h-2.5" />
                              <span>РЕКОМЕНДАЦИЯ ИИ</span>
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
                            <span>СТЕК ОШИБКИ</span>
                          </summary>
                          <div className="mt-1 p-2 bg-black rounded border border-zinc-800 font-mono text-[10px] text-red-300/80 whitespace-pre-wrap overflow-x-auto">
                            {incident.raw_error}
                          </div>
                        </details>

                        <div className="text-[9px] font-mono text-zinc-500 flex items-center justify-between pt-0.5">
                          <span title={formatExactTime(incident.created_at)}>
                            Первое: {formatRelativeTime(incident.created_at)}
                          </span>
                          <span title={formatExactTime(incident.last_occurred_at)}>
                            Последнее: {formatRelativeTime(incident.last_occurred_at)}
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
                  setIncidentStatusFilter('ALL');
                  setActiveTab('incidents');
                }}
                className="inline-flex items-center gap-1 text-red-400 hover:text-red-300 cursor-pointer"
              >
                <span>Перейти в ленту инцидентов</span>
                <ExternalLink className="w-3 h-3" />
              </button>

              <button
                onClick={() => setInspectedShopName(null)}
                className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white cursor-pointer"
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. Модальное окно подтверждения закрытия инцидента */}
      {incidentToResolve && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85">
          <div
            className="bg-zinc-900 border border-zinc-700 rounded max-w-sm w-full p-4 space-y-3 font-mono shadow-2xl"
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
                    ПОДТВЕРЖДЕНИЕ ЗАКРЫТИЯ
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
                Сбой: <span className="text-red-300">{incidentToResolve.error_type}</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-0.5 text-xs">
              <button
                type="button"
                onClick={() => setIncidentToResolve(null)}
                className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white cursor-pointer"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => executeResolve(incidentToResolve.id)}
                className="px-3 py-1 rounded bg-emerald-900 hover:bg-emerald-800 text-emerald-100 font-semibold border border-emerald-700 cursor-pointer flex items-center gap-1"
              >
                <Check className="w-3 h-3 text-emerald-400" />
                <span>Починено</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
