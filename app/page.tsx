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
  Clock,
  Sparkles,
  ChevronDown,
  CheckCircle2,
  AlertCircle,
  X,
  FileText,
  ArrowRight,
  History,
  LogOut,
  PowerOff,
  RotateCcw,
  Store,
  User,
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
 * Форматирование времени относительно текущего момента
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
 * Форматирование точной даты для подсказок
 */
function formatExactTime(dateString: string | null | undefined): string {
  if (!dateString) return 'нет данных';
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return 'нет данных';
  return d.toLocaleString('ru-RU');
}

/**
 * Человекопонятное описание действия для журнала аудита
 */
function formatAuditAction(action: string): { label: string; color: string } {
  switch (action) {
    case 'RESOLVE_INCIDENT':
      return { label: 'Закрытие сбоя', color: 'text-emerald-400' };
    case 'REOPEN_INCIDENT':
      return { label: 'Возврат в работу', color: 'text-amber-400' };
    case 'TOGGLE_PAUSE':
      return { label: 'Пауза опроса сети', color: 'text-rose-400' };
    case 'LOGIN':
      return { label: 'Вход в систему', color: 'text-zinc-400' };
    default:
      return { label: action, color: 'text-zinc-300' };
  }
}

export default function NocDashboardPage() {
  const [activeTab, setActiveTab] = useState<'incidents' | 'workplaces'>('incidents');
  const [incidents, setIncidents] = useState<DashboardIncidentRow[]>([]);
  const [workplaces, setWorkplaces] = useState<DashboardWorkplaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL_SECONDS);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [resolvingIds, setResolvingIds] = useState<Set<number>>(new Set());

  // Текущий авторизованный пользователь и его роль (RBAC)
  const [currentUser, setCurrentUser] = useState<{
    username: string;
    role: 'ADMIN' | 'ENGINEER';
  } | null>(null);

  // Состояние подтверждения закрытия инцидента («Починено»)
  const [incidentToResolve, setIncidentToResolve] = useState<DashboardIncidentRow | null>(null);

  // Состояние инспектора точки («Досье магазина» — UX Drill-Down + Audit Trail)
  const [inspectedShopName, setInspectedShopName] = useState<string | null>(null);
  const [inspectedModalFilter, setInspectedModalFilter] = useState<'ALL' | 'ACTIVE' | 'RESOLVED'>('ALL');

  // Фильтры во вкладке «Сбои»
  const [incidentStatusFilter, setIncidentStatusFilter] = useState<'ALL' | 'ACTIVE' | 'RESOLVED'>('ACTIVE');
  const [incidentSearchQuery, setIncidentSearchQuery] = useState('');
  const [selectedShopFilter, setSelectedShopFilter] = useState('ALL');

  // Поиск во вкладке «Магазины и кассы»
  const [workplaceSearchQuery, setWorkplaceSearchQuery] = useState('');

  // Состояние паузы опроса сети (Kill-Switch) и выхода
  const [killSwitchActive, setKillSwitchActive] = useState(false);
  const [killSwitchModalOpen, setKillSwitchModalOpen] = useState(false);
  const [killSwitchLoading, setKillSwitchLoading] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);

  // Состояние модального окна «Журнал действий» (Audit Log)
  const [auditModalOpen, setAuditModalOpen] = useState(false);
  const [auditLogs, setAuditLogs] = useState<
    Array<{
      id: number;
      username: string;
      action: string;
      details: string | null;
      created_at: string;
    }>
  >([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // Загрузка текущего профиля пользователя
  useEffect(() => {
    fetch('/api/v1/auth/me', { cache: 'no-store' })
      .then((res) => {
        if (res.status === 403) {
          // Инженер заблокирован при активном аварийном режиме (Kill Switch)
          window.location.href = '/login?reason=kill_switch';
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((data) => {
        if (data && data.username) {
          setCurrentUser(data);
        }
      })
      .catch((err) => {
        console.error('Ошибка получения сессии пользователя', err);
      });
  }, []);

  const fetchKillSwitch = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/system/kill-switch', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setKillSwitchActive(Boolean(data.kill_switch_active ?? data.active));
      }
    } catch (err) {
      console.error('Ошибка проверки статуса паузы сети', err);
    }
  }, []);

  const handleToggleKillSwitch = async () => {
    setKillSwitchLoading(true);
    try {
      const res = await fetch('/api/v1/system/kill-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !killSwitchActive }),
      });
      if (res.ok) {
        const data = await res.json();
        setKillSwitchActive(Boolean(data.kill_switch_active ?? data.active));
        setKillSwitchModalOpen(false);
      } else {
        const errData = await res.json().catch(() => ({}));
        alert(errData.error || 'Ошибка изменения статуса паузы');
      }
    } catch (err) {
      console.error('Ошибка переключения паузы сети', err);
    } finally {
      setKillSwitchLoading(false);
    }
  };

  const handleLogout = async () => {
    setLogoutLoading(true);
    try {
      await fetch('/api/v1/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login';
    }
  };

  const fetchAuditLogs = useCallback(async () => {
    setAuditLoading(true);
    try {
      const res = await fetch('/api/v1/audit', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setAuditLogs(data.logs || []);
      }
    } catch (err) {
      console.error('Ошибка загрузки журнала аудита', err);
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const openAuditModal = () => {
    setAuditModalOpen(true);
    fetchAuditLogs();
  };

  // Загрузка данных с сервера
  const fetchData = useCallback(async (isSilent = false) => {
    if (!isSilent) setRefreshing(true);
    fetchKillSwitch();
    try {
      const res = await fetch('/api/v1/dashboard/data', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setIncidents(data.incidents || []);
        setWorkplaces(data.workplaces || []);
      }
    } catch (err) {
      console.error('Не удалось загрузить данные мониторинга', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setCountdown(REFRESH_INTERVAL_SECONDS);
    }
  }, [fetchKillSwitch]);

  // Первоначальная загрузка
  useEffect(() => {
    let ignore = false;
    async function load() {
      fetchKillSwitch();
      try {
        const res = await fetch('/api/v1/dashboard/data', { cache: 'no-store' });
        if (res.ok && !ignore) {
          const data = await res.json();
          setIncidents(data.incidents || []);
          setWorkplaces(data.workplaces || []);
        }
      } catch (err) {
        console.error('Не удалось загрузить данные мониторинга', err);
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
  }, [fetchKillSwitch]);

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
        } else if (killSwitchModalOpen) {
          setKillSwitchModalOpen(false);
        } else if (auditModalOpen) {
          setAuditModalOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [incidentToResolve, inspectedShopName, killSwitchModalOpen, auditModalOpen]);

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
    const currentUsername = currentUser?.username || 'дежурный';

    // Оптимистичное обновление статуса и автора в локальном стейте
    setIncidents((prev) =>
      prev.map((item) =>
        item.id === incidentId
          ? {
              ...item,
              status: 'RESOLVED',
              resolved_at: nowIso,
              resolved_by: currentUsername,
            }
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

  // Возобновление инцидента («Вернуть в работу»)
  const executeReopen = async (incidentId: number) => {
    setResolvingIds((prev) => new Set(prev).add(incidentId));

    // Оптимистичное обновление статуса в локальном стейте
    setIncidents((prev) =>
      prev.map((item) =>
        item.id === incidentId
          ? { ...item, status: 'ACTIVE', resolved_at: null, resolved_by: null }
          : item
      )
    );

    // Увеличиваем счетчик активных сбоев кассы
    const target = incidents.find((i) => i.id === incidentId);
    if (target) {
      setWorkplaces((prev) =>
        prev.map((wp) => {
          if (wp.id === target.workplace_id) {
            return {
              ...wp,
              active_incidents_count: wp.active_incidents_count + 1,
            };
          }
          return wp;
        })
      );
    }

    try {
      const res = await fetch(`/api/v1/incidents/${incidentId}/reopen`, {
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

  // Уникальное количество магазинов в сети
  const uniqueShopsCount = useMemo(() => {
    const set = new Set<string>();
    for (const w of workplaces) set.add(w.shop_name);
    for (const i of incidents) set.add(i.shop_name);
    return set.size;
  }, [workplaces, incidents]);

  // Фильтрация инцидентов в основной ленте
  const filteredIncidents = useMemo(() => {
    return incidents.filter((inc) => {
      if (incidentStatusFilter === 'ACTIVE' && inc.status !== 'ACTIVE') return false;
      if (incidentStatusFilter === 'RESOLVED' && inc.status !== 'RESOLVED') return false;

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

  // Метрики касс
  const stats = useMemo(() => {
    const total = workplaces.length;
    const online = workplaces.filter((w) => w.is_online).length;
    const offline = total - online;
    const noRemote = workplaces.filter((w) => !w.remote_id || w.remote_type === 'NONE').length;
    return { total, online, offline, noRemote };
  }, [workplaces]);

  // Фильтрация реестра касс на лету
  const filteredWorkplaces = useMemo(() => {
    if (!workplaceSearchQuery.trim()) return workplaces;
    const q = workplaceSearchQuery.toLowerCase().trim();
    return workplaces.filter(
      (w) =>
        w.shop_name.toLowerCase().includes(q) ||
        w.workplace_name.toLowerCase().includes(q) ||
        (w.remote_id && w.remote_id.toLowerCase().includes(q))
    );
  }, [workplaces, workplaceSearchQuery]);

  const isAdmin = currentUser?.role === 'ADMIN';

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-zinc-800 selection:text-white">
      {/* 1. Спокойная шапка (Linear / GitHub Dark style) */}
      <header className="sticky top-0 z-40 bg-zinc-950/90 backdrop-blur-md border-b border-zinc-800/80 px-4 md:px-8 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          {/* Бренд и статус сети */}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-200">
              <Monitor className="w-4 h-4 text-zinc-300" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-semibold text-zinc-100 tracking-tight">
                  Мониторинг 1С
                </h1>
                <span className="text-zinc-600">·</span>
                {activeIncidents.length === 0 ? (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    Все кассы в норме
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-xs text-rose-400 font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
                    Есть сбои: {activeIncidents.length}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Панель быстрых действий и профиля */}
          <div className="flex items-center gap-2 text-xs">
            {/* Профиль сотрудника (RBAC) */}
            {currentUser && (
              <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 text-xs">
                <User className="w-3.5 h-3.5 text-zinc-400" />
                <span className="font-medium text-zinc-200">{currentUser.username}</span>
                <span className="text-zinc-600">·</span>
                <span
                  className={`text-[11px] ${
                    isAdmin ? 'text-amber-400/90 font-medium' : 'text-zinc-400'
                  }`}
                >
                  {isAdmin ? 'Администратор' : 'Инженер'}
                </span>
              </div>
            )}

            {/* Кнопка «Журнал действий» */}
            <button
              onClick={openAuditModal}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-zinc-900 hover:bg-zinc-850 text-zinc-300 hover:text-zinc-100 border border-zinc-800 hover:border-zinc-700 transition-colors cursor-pointer"
              title="Журнал действий смены (аудит)"
            >
              <History className="w-3.5 h-3.5 text-zinc-400" />
              <span>Журнал</span>
            </button>

            {/* Элемент управления: «Пауза опроса сети» (Kill-Switch) */}
            {isAdmin ? (
              <button
                onClick={() => setKillSwitchModalOpen(true)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium transition-colors cursor-pointer ${
                  killSwitchActive
                    ? 'bg-rose-950/40 border-rose-800 text-rose-300 hover:bg-rose-900/40'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                }`}
                title="Сервисная пауза опроса сети касс"
              >
                <PowerOff
                  className={`w-3.5 h-3.5 ${killSwitchActive ? 'text-rose-400' : 'text-zinc-500'}`}
                />
                <span>{killSwitchActive ? 'Пауза: включена' : 'Пауза опроса сети'}</span>
              </button>
            ) : (
              <div title="Доступно только администраторам">
                <button
                  disabled
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium bg-zinc-900/60 border-zinc-850 text-zinc-500 opacity-40 cursor-not-allowed"
                >
                  <PowerOff className="w-3.5 h-3.5 text-zinc-600" />
                  <span>Пауза опроса сети</span>
                </button>
              </div>
            )}

            {/* Кнопка обновления с таймером */}
            <button
              onClick={() => fetchData()}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-zinc-900 hover:bg-zinc-850 text-zinc-300 hover:text-zinc-100 border border-zinc-800 hover:border-zinc-700 transition-colors disabled:opacity-50 cursor-pointer"
              title="Обновить вручную"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin text-zinc-400' : 'text-zinc-500'}`}
              />
              <span className="text-zinc-400">Обновить ({countdown}с)</span>
            </button>

            {/* Выход из системы */}
            <button
              onClick={handleLogout}
              disabled={logoutLoading}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-zinc-900 hover:bg-zinc-850 text-zinc-400 hover:text-zinc-200 border border-zinc-800 hover:border-zinc-700 transition-colors cursor-pointer disabled:opacity-50"
              title="Выйти из мониторинга"
            >
              <LogOut className="w-3.5 h-3.5 text-zinc-500" />
              <span>Выйти</span>
            </button>
          </div>
        </div>
      </header>

      {/* 2. Основная рабочая область */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 md:px-8 py-6 space-y-6">
        {/* Карточки ключевых показателей */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Требуют внимания */}
          <div className="p-3.5 rounded-lg bg-zinc-900/50 border border-zinc-800/80">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Требуют внимания</span>
              <AlertCircle
                className={`w-4 h-4 ${activeIncidents.length > 0 ? 'text-rose-400' : 'text-zinc-500'}`}
              />
            </div>
            <div className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">
              {activeIncidents.length}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              {activeIncidents.length > 0
                ? `${activeIncidents.length} ${pluralizeRu(
                    activeIncidents.length,
                    'активный сбой',
                    'активных сбоя',
                    'активных сбоев'
                  )}`
                : 'Критических проблем нет'}
            </div>
          </div>

          {/* Касс онлайн */}
          <div className="p-3.5 rounded-lg bg-zinc-900/50 border border-zinc-800/80">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Касс онлайн</span>
              <Monitor className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">
              {stats.online}{' '}
              <span className="text-sm font-normal text-zinc-500">/ {stats.total}</span>
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              {stats.offline > 0
                ? `${stats.offline} ${pluralizeRu(
                    stats.offline,
                    'касса не на связи',
                    'кассы не на связи',
                    'касс не на связи'
                  )}`
                : 'Все кассы подключены'}
            </div>
          </div>

          {/* Магазинов в сети */}
          <div className="p-3.5 rounded-lg bg-zinc-900/50 border border-zinc-800/80">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Магазинов в сети</span>
              <Store className="w-4 h-4 text-zinc-400" />
            </div>
            <div className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">
              {uniqueShopsCount}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Торговые точки в мониторинге
            </div>
          </div>

          {/* Решено за 14 дней */}
          <div className="p-3.5 rounded-lg bg-zinc-900/50 border border-zinc-800/80">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Решено</span>
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="mt-2 text-2xl font-semibold tracking-tight text-zinc-100">
              {resolvedIncidents.length}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Успешно закрытые сбои
            </div>
          </div>
        </section>

        {/* Навигационные сегментированные вкладки */}
        <div className="flex items-center justify-between gap-4 border-b border-zinc-800/80 pb-3">
          <div className="inline-flex p-1 bg-zinc-900/80 border border-zinc-800/80 rounded-lg">
            <button
              onClick={() => setActiveTab('incidents')}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                activeTab === 'incidents'
                  ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <AlertTriangle
                className={`w-3.5 h-3.5 ${
                  activeIncidents.length > 0 ? 'text-rose-400' : 'text-zinc-400'
                }`}
              />
              <span>Сбои</span>
              {activeIncidents.length > 0 && (
                <span className="text-[11px] font-semibold text-rose-400">
                  {activeIncidents.length}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('workplaces')}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                activeTab === 'workplaces'
                  ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Store className="w-3.5 h-3.5 text-zinc-400" />
              <span>Магазины и кассы</span>
              <span className="text-[11px] text-zinc-500">{workplaces.length}</span>
            </button>
          </div>
        </div>

        {/* Содержимое вкладок */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 text-zinc-500 space-y-3 text-xs">
            <RefreshCw className="w-5 h-5 text-zinc-400 animate-spin" />
            <p>Загрузка данных...</p>
          </div>
        ) : activeTab === 'incidents' ? (
          /* =========================================================================
             ВКЛАДКА 1: СБОИ
             ========================================================================= */
          <div className="space-y-4">
            {/* Панель фильтров */}
            <div className="p-3 rounded-lg bg-zinc-900/40 border border-zinc-800/80 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 flex-1">
                {/* Живой поиск */}
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    placeholder="Поиск по ошибке, магазину, кассе..."
                    value={incidentSearchQuery}
                    onChange={(e) => setIncidentSearchQuery(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-md pl-8 pr-7 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700 transition-colors"
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
                <div className="relative min-w-[220px]">
                  <select
                    value={selectedShopFilter}
                    onChange={(e) => setSelectedShopFilter(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-zinc-700 cursor-pointer appearance-none pr-8"
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

              {/* Сегментированный переключатель статуса */}
              <div className="flex items-center gap-1 self-start sm:self-auto">
                <div className="inline-flex p-0.5 bg-zinc-950 border border-zinc-800 rounded-md text-xs">
                  <button
                    onClick={() => setIncidentStatusFilter('ACTIVE')}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                      incidentStatusFilter === 'ACTIVE'
                        ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    Только активные ({activeIncidents.length})
                  </button>
                  <button
                    onClick={() => setIncidentStatusFilter('ALL')}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                      incidentStatusFilter === 'ALL'
                        ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    Все ({incidents.length})
                  </button>
                  <button
                    onClick={() => setIncidentStatusFilter('RESOLVED')}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                      incidentStatusFilter === 'RESOLVED'
                        ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    Решенные ({resolvedIncidents.length})
                  </button>
                </div>

                {(incidentSearchQuery ||
                  selectedShopFilter !== 'ALL' ||
                  incidentStatusFilter !== 'ACTIVE') && (
                  <button
                    onClick={() => {
                      setIncidentSearchQuery('');
                      setSelectedShopFilter('ALL');
                      setIncidentStatusFilter('ACTIVE');
                    }}
                    className="ml-2 text-xs text-zinc-400 hover:text-zinc-200 underline cursor-pointer"
                  >
                    Сбросить
                  </button>
                )}
              </div>
            </div>

            {/* Список сбоев */}
            {incidents.length === 0 ? (
              <div className="p-12 text-center rounded-lg bg-zinc-900/30 border border-zinc-800/80 space-y-2">
                <div className="w-9 h-9 rounded-full bg-emerald-950/40 border border-emerald-800/40 text-emerald-400 flex items-center justify-center mx-auto">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <h3 className="text-sm font-medium text-zinc-200">Сбоев не зафиксировано</h3>
                <p className="text-xs text-zinc-500 max-w-sm mx-auto">
                  Все кассовые узлы торговой сети работают в штатном режиме.
                </p>
              </div>
            ) : filteredIncidents.length === 0 ? (
              <div className="p-10 text-center rounded-lg bg-zinc-900/30 border border-zinc-800/80 space-y-2">
                <AlertCircle className="w-5 h-5 text-zinc-500 mx-auto" />
                <p className="text-xs text-zinc-300">По заданным условиям сбоев не найдено</p>
                <button
                  onClick={() => {
                    setIncidentSearchQuery('');
                    setSelectedShopFilter('ALL');
                    setIncidentStatusFilter('ALL');
                  }}
                  className="text-xs text-zinc-400 hover:text-zinc-200 underline cursor-pointer"
                >
                  Показать все записи
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredIncidents.map((incident) => {
                  const isResolving = resolvingIds.has(incident.id);
                  const isResolved = incident.status === 'RESOLVED';
                  const isAnyDesk =
                    incident.remote_type === 'ANYDESK' && Boolean(incident.remote_id);
                  const isRuDesktop =
                    incident.remote_type === 'RUDESKTOP' && Boolean(incident.remote_id);

                  return (
                    <article
                      key={incident.id}
                      className={`p-4 rounded-lg border transition-colors space-y-3 ${
                        isResolved
                          ? 'bg-zinc-900/25 border-zinc-800/50 opacity-90'
                          : 'bg-zinc-900/50 border-zinc-800/90 hover:border-zinc-700/80'
                      }`}
                    >
                      {/* Шапка карточки: Метаданные и Действия */}
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                        <div className="space-y-1">
                          {/* Метаданные через типографические разделители (Zero-Pill Discipline) */}
                          <div className="flex items-center gap-2 text-xs text-zinc-400 flex-wrap">
                            {isResolved ? (
                              <span className="flex items-center gap-1 text-emerald-400 font-medium">
                                <Check className="w-3.5 h-3.5" />
                                Решено
                              </span>
                            ) : incident.severity === 'WARN' ? (
                              <span className="flex items-center gap-1 text-amber-400 font-medium">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                                Предупреждение
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-rose-400 font-medium">
                                <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                                Критический сбой
                              </span>
                            )}

                            <span className="text-zinc-600">·</span>
                            <span className="text-zinc-400 font-medium">{incident.shop_name}</span>
                            <span className="text-zinc-600">·</span>
                            <span className="text-zinc-300 font-mono">
                              {incident.workplace_name}
                            </span>
                            <span className="text-zinc-600">·</span>
                            <span className="text-zinc-500">
                              {incident.occurrences_count}{' '}
                              {pluralizeRu(
                                incident.occurrences_count,
                                'повтор',
                                'повтора',
                                'повторов'
                              )}
                            </span>
                            <span className="text-zinc-600">·</span>
                            <span
                              className="text-zinc-500"
                              title={formatExactTime(incident.last_occurred_at)}
                            >
                              {formatRelativeTime(incident.last_occurred_at)}
                            </span>

                            {/* Автор закрытия (Step 3: resolved_by) */}
                            {isResolved && (
                              <>
                                <span className="text-zinc-600">·</span>
                                <span
                                  className="text-zinc-400"
                                  title={
                                    incident.resolved_at
                                      ? formatExactTime(incident.resolved_at)
                                      : undefined
                                  }
                                >
                                  Решено:{' '}
                                  <strong className="text-zinc-200 font-medium">
                                    {incident.resolved_by || 'дежурный'}
                                  </strong>
                                  {incident.resolved_at
                                    ? ` · ${formatRelativeTime(incident.resolved_at)}`
                                    : ''}
                                </span>
                              </>
                            )}
                          </div>

                          {/* Суть ошибки */}
                          <h2 className="text-sm font-semibold text-zinc-100 pt-0.5">
                            {incident.error_type}
                          </h2>
                        </div>

                        {/* Кнопки действий */}
                        <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap self-start">
                          {/* AnyDesk подключение */}
                          {isAnyDesk && (
                            <div className="flex items-center gap-1">
                              <a
                                href={`anydesk://${incident.remote_id}`}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-750 text-zinc-200 border border-zinc-700/80 text-xs font-medium transition-colors"
                                title="Подключиться через AnyDesk"
                              >
                                <ExternalLink className="w-3 h-3 text-zinc-400" />
                                <span>AnyDesk: {incident.remote_id}</span>
                              </a>
                              <button
                                onClick={() =>
                                  copyToClipboard(incident.remote_id!, `desk-${incident.id}`)
                                }
                                className="p-1 rounded-md bg-zinc-850 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-750 cursor-pointer"
                                title="Скопировать AnyDesk ID"
                              >
                                {copiedKey === `desk-${incident.id}` ? (
                                  <Check className="w-3 h-3 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                              </button>
                            </div>
                          )}

                          {/* RuDesktop */}
                          {isRuDesktop && (
                            <button
                              onClick={() =>
                                copyToClipboard(incident.remote_id!, `rudesk-${incident.id}`)
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-750 text-zinc-300 border border-zinc-700/80 text-xs cursor-pointer"
                              title="Скопировать номер RuDesktop"
                            >
                              {copiedKey === `rudesk-${incident.id}` ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                              <span>RuDesktop: {incident.remote_id}</span>
                            </button>
                          )}

                          {/* Досье магазина */}
                          <button
                            onClick={() => {
                              setInspectedShopName(incident.shop_name);
                              setInspectedModalFilter('ALL');
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 border border-zinc-800 text-xs cursor-pointer transition-colors"
                            title="Открыть досье магазина"
                          >
                            <FileText className="w-3 h-3 text-zinc-400" />
                            <span>Магазин</span>
                          </button>

                          {/* Решение / Возобновление сбоя */}
                          {!isResolved ? (
                            <button
                              onClick={() => setIncidentToResolve(incident)}
                              disabled={isResolving}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-950/60 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800/80 text-xs font-medium cursor-pointer transition-colors disabled:opacity-50"
                            >
                              <Check className="w-3 h-3 text-emerald-400" />
                              <span>{isResolving ? 'Сохранение...' : 'Починено'}</span>
                            </button>
                          ) : (
                            <button
                              onClick={() => executeReopen(incident.id)}
                              disabled={isResolving}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-zinc-850 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 border border-zinc-750 text-xs cursor-pointer transition-colors disabled:opacity-50"
                              title="Вернуть в активные сбои"
                            >
                              <RotateCcw className="w-3 h-3 text-zinc-400" />
                              <span>{isResolving ? 'Возврат...' : 'Вернуть в работу'}</span>
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Диагностика AI-Triage */}
                      {incident.ai_diagnosis && (
                        <div className="p-3 rounded-md bg-zinc-950/60 border border-zinc-800/80 space-y-1.5 text-xs">
                          <div className="flex items-center gap-1.5 text-zinc-400 font-medium">
                            <Sparkles className="w-3 h-3 text-zinc-400" />
                            <span>Рекомендация по устранению</span>
                          </div>
                          <p className="text-zinc-200 leading-relaxed font-sans">
                            {incident.ai_diagnosis}
                          </p>
                          {incident.ai_actions && (
                            <div className="pt-1.5 border-t border-zinc-850 text-zinc-400 font-mono text-[11px] whitespace-pre-wrap leading-relaxed">
                              {incident.ai_actions}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Стек ошибки */}
                      <details className="group text-xs">
                        <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300 flex items-center gap-1 select-none text-[11px] transition-colors">
                          <ChevronDown className="w-3 h-3 group-open:rotate-180 transition-transform" />
                          <span>Стек ошибки 1С</span>
                        </summary>
                        <div className="mt-2 p-2.5 rounded-md bg-zinc-950 border border-zinc-850 font-mono text-[11px] text-zinc-400 whitespace-pre-wrap overflow-x-auto leading-relaxed">
                          {incident.raw_error}
                        </div>
                      </details>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          /* =========================================================================
             ВКЛАДКА 2: МАГАЗИНЫ И КАССЫ
             ========================================================================= */
          <div className="space-y-4">
            {/* Поиск по кассам */}
            <div className="p-3 rounded-lg bg-zinc-900/40 border border-zinc-800/80 flex items-center justify-between gap-3 text-xs">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Поиск по названию магазина, кассе или номеру AnyDesk..."
                  value={workplaceSearchQuery}
                  onChange={(e) => setWorkplaceSearchQuery(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-md pl-8 pr-7 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700 transition-colors"
                />
                {workplaceSearchQuery && (
                  <button
                    onClick={() => setWorkplaceSearchQuery('')}
                    className="absolute right-2.5 top-2 text-zinc-500 hover:text-zinc-300 cursor-pointer"
                    title="Очистить"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="text-zinc-400 text-xs hidden sm:block whitespace-nowrap">
                Найдено: <strong className="text-zinc-200">{filteredWorkplaces.length}</strong>
              </div>
            </div>

            {/* Карточки рабочих мест */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredWorkplaces.map((wp) => {
                const hasRemote = Boolean(wp.remote_id) && wp.remote_type !== 'NONE';

                return (
                  <div
                    key={wp.id}
                    onClick={() => {
                      setInspectedShopName(wp.shop_name);
                      setInspectedModalFilter('ALL');
                    }}
                    className="p-3.5 rounded-lg bg-zinc-900/50 border border-zinc-800/80 hover:border-zinc-700/80 transition-colors flex flex-col justify-between cursor-pointer group space-y-3"
                  >
                    <div className="space-y-2">
                      {/* Верхняя строка карточки: статус связи и сбои */}
                      <div className="flex items-center justify-between text-xs">
                        <div>
                          {wp.is_online ? (
                            <span
                              className="text-emerald-400 flex items-center gap-1.5"
                              title={formatExactTime(wp.last_seen)}
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                              <span>На связи ({formatRelativeTime(wp.last_seen)})</span>
                            </span>
                          ) : (
                            <span
                              className="text-zinc-500 flex items-center gap-1.5"
                              title={formatExactTime(wp.last_seen)}
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
                              <span>Не в сети ({formatRelativeTime(wp.last_seen)})</span>
                            </span>
                          )}
                        </div>

                        {/* Индикатор проблем */}
                        {wp.active_incidents_count > 0 ? (
                          <span className="text-rose-400 text-xs font-medium flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                            {wp.active_incidents_count}{' '}
                            {pluralizeRu(wp.active_incidents_count, 'сбой', 'сбоя', 'сбоев')}
                          </span>
                        ) : (
                          <span className="text-zinc-500 text-xs">В норме</span>
                        )}
                      </div>

                      {/* Название магазина и кассы */}
                      <div>
                        <h3 className="font-semibold text-zinc-100 text-sm group-hover:text-zinc-50 flex items-center justify-between">
                          <span>{wp.shop_name}</span>
                          <ArrowRight className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 text-zinc-400 transition-opacity" />
                        </h3>
                        <p className="text-xs text-zinc-400 font-mono mt-0.5">{wp.workplace_name}</p>
                      </div>

                      {/* Удаленный доступ */}
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="p-2 bg-zinc-950 rounded-md border border-zinc-850 space-y-1 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-500">Удаленный доступ:</span>
                          {hasRemote ? (
                            <div className="flex items-center gap-1">
                              {wp.remote_type === 'ANYDESK' ? (
                                <a
                                  href={`anydesk://${wp.remote_id}`}
                                  className="text-zinc-200 hover:text-white flex items-center gap-1 font-mono text-xs"
                                  title="Открыть AnyDesk"
                                >
                                  {wp.remote_id}
                                  <ExternalLink className="w-2.5 h-2.5 text-zinc-500" />
                                </a>
                              ) : (
                                <span className="text-zinc-200 font-mono text-xs">{wp.remote_id}</span>
                              )}
                              <button
                                onClick={() => copyToClipboard(wp.remote_id!, `wp-remote-${wp.id}`)}
                                className="p-0.5 text-zinc-500 hover:text-zinc-200 cursor-pointer"
                                title="Скопировать AnyDesk ID"
                              >
                                {copiedKey === `wp-remote-${wp.id}` ? (
                                  <Check className="w-3 h-3 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                              </button>
                            </div>
                          ) : (
                            <span className="text-zinc-500 text-[11px]">Не настроен</span>
                          )}
                        </div>

                        {/* Пароль поддержки */}
                        <div className="flex items-center justify-between pt-1 border-t border-zinc-850 text-xs">
                          <span className="text-zinc-500">Пароль:</span>
                          <button
                            onClick={() => copyToClipboard(SUPPORT_PASSWORD, `wp-pass-${wp.id}`)}
                            className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-200 cursor-pointer text-xs"
                            title="Скопировать пароль AnyDesk"
                          >
                            <Key className="w-3 h-3 text-zinc-500" />
                            <span>
                              {copiedKey === `wp-pass-${wp.id}` ? 'Скопирован' : 'Скопировать'}
                            </span>
                          </button>
                        </div>
                      </div>

                      {/* Системные характеристики */}
                      {wp.system_info && (
                        <div className="flex flex-wrap gap-1 text-[11px] text-zinc-500 pt-0.5">
                          {Boolean(wp.system_info.platform_version) && (
                            <span>1С {String(wp.system_info.platform_version)}</span>
                          )}
                          {Boolean(wp.system_info.ram_gb) && (
                            <>
                              <span className="text-zinc-700">·</span>
                              <span className="flex items-center gap-0.5">
                                <Cpu className="w-2.5 h-2.5 text-zinc-500" />
                                {String(wp.system_info.ram_gb)} ГБ
                              </span>
                            </>
                          )}
                          {Boolean(wp.system_info.os) && (
                            <>
                              <span className="text-zinc-700">·</span>
                              <span className="truncate max-w-[120px]">
                                {String(wp.system_info.os)}
                              </span>
                            </>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="text-[11px] text-zinc-500 pt-2 border-t border-zinc-850 flex items-center justify-between">
                      <span>Нажмите для открытия досье</span>
                      <span className="text-zinc-400 group-hover:text-zinc-200">&rarr;</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>

      {/* 3. Модальное окно «Досье магазина» */}
      {inspectedShopName && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-6 bg-black/75 backdrop-blur-sm">
          <div
            className="bg-zinc-900 border border-zinc-800 rounded-lg max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden shadow-2xl"
            role="dialog"
            aria-modal="true"
          >
            {/* Шапка модалки досье */}
            <div className="p-4 border-b border-zinc-800 flex items-start justify-between bg-zinc-950">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-zinc-100">{inspectedShopName}</h2>
                </div>
                <div className="flex items-center gap-2 text-xs text-zinc-400 flex-wrap">
                  <span>Касс: {inspectedData.shopWorkplaces.length}</span>
                  <span className="text-zinc-600">·</span>
                  <span>
                    Активных сбоев:{' '}
                    <strong
                      className={
                        inspectedData.activeIncidents.length > 0
                          ? 'text-rose-400'
                          : 'text-emerald-400'
                      }
                    >
                      {inspectedData.activeIncidents.length}
                    </strong>
                  </span>
                  <span className="text-zinc-600">·</span>
                  <span>В архиве: {inspectedData.resolvedIncidents.length}</span>
                  <span className="text-zinc-600">·</span>
                  <button
                    onClick={() => copyToClipboard(SUPPORT_PASSWORD, 'inspect-modal-pass')}
                    className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                    title="Скопировать пароль AnyDesk"
                  >
                    <Key className="w-3 h-3 text-zinc-400" />
                    <span>
                      {copiedKey === 'inspect-modal-pass' ? 'Скопирован' : 'Пароль кассы'}
                    </span>
                  </button>
                </div>
              </div>

              <button
                onClick={() => setInspectedShopName(null)}
                className="text-zinc-400 hover:text-zinc-200 p-1.5 rounded-md hover:bg-zinc-800 cursor-pointer transition-colors"
                title="Закрыть (Esc)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Фильтры истории внутри досье */}
            <div className="px-4 py-2 bg-zinc-950/80 border-b border-zinc-800 flex items-center justify-between text-xs">
              <div className="inline-flex p-0.5 bg-zinc-900 border border-zinc-800 rounded-md">
                <button
                  onClick={() => setInspectedModalFilter('ALL')}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                    inspectedModalFilter === 'ALL'
                      ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Все сбои ({inspectedData.allIncidents.length})
                </button>
                <button
                  onClick={() => setInspectedModalFilter('ACTIVE')}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                    inspectedModalFilter === 'ACTIVE'
                      ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Активные ({inspectedData.activeIncidents.length})
                </button>
                <button
                  onClick={() => setInspectedModalFilter('RESOLVED')}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                    inspectedModalFilter === 'RESOLVED'
                      ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Решенные ({inspectedData.resolvedIncidents.length})
                </button>
              </div>

              <div className="text-zinc-500 text-xs hidden sm:flex items-center gap-1.5">
                <History className="w-3.5 h-3.5 text-zinc-500" />
                <span>История за 14 дней</span>
              </div>
            </div>

            {/* Тело модалки досье */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {inspectedData.allIncidents.length === 0 ? (
                <div className="p-8 text-center rounded-lg bg-zinc-950/50 border border-zinc-850 space-y-2">
                  <div className="w-8 h-8 rounded-full bg-emerald-950/40 border border-emerald-800/40 text-emerald-400 flex items-center justify-center mx-auto">
                    <ShieldCheck className="w-4 h-4" />
                  </div>
                  <h3 className="text-xs font-medium text-zinc-200">Сбоев не зафиксировано</h3>
                  <p className="text-xs text-zinc-500 max-w-sm mx-auto">
                    За последние 14 дней на кассах магазина «{inspectedShopName}» сбоев не возникало.
                  </p>
                </div>
              ) : displayedInspectedIncidents.length === 0 ? (
                <div className="p-6 text-center rounded-lg bg-zinc-950/50 border border-zinc-850 space-y-2 text-xs">
                  <p className="text-zinc-400">В этой категории записей не найдено.</p>
                  <button
                    onClick={() => setInspectedModalFilter('ALL')}
                    className="text-zinc-400 hover:text-zinc-200 underline cursor-pointer"
                  >
                    Показать все записи ({inspectedData.allIncidents.length})
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {displayedInspectedIncidents.map((incident) => {
                    const isResolving = resolvingIds.has(incident.id);
                    const isResolved = incident.status === 'RESOLVED';
                    const isAnyDesk =
                      incident.remote_type === 'ANYDESK' && Boolean(incident.remote_id);
                    const isRuDesktop =
                      incident.remote_type === 'RUDESKTOP' && Boolean(incident.remote_id);

                    return (
                      <div
                        key={incident.id}
                        className={`p-3.5 rounded-lg border transition-colors space-y-2.5 ${
                          isResolved
                            ? 'bg-zinc-950/40 border-zinc-850/80 opacity-90'
                            : 'bg-zinc-950 border-zinc-800'
                        }`}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2 text-xs text-zinc-400 flex-wrap">
                              {isResolved ? (
                                <span className="flex items-center gap-1 text-emerald-400 font-medium">
                                  <Check className="w-3.5 h-3.5" />
                                  Решено
                                </span>
                              ) : incident.severity === 'WARN' ? (
                                <span className="flex items-center gap-1 text-amber-400 font-medium">
                                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                                  Предупреждение
                                </span>
                              ) : (
                                <span className="flex items-center gap-1 text-rose-400 font-medium">
                                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                                  В работе
                                </span>
                              )}

                              <span className="text-zinc-600">·</span>
                              <span className="font-mono text-zinc-300 font-medium">
                                {incident.workplace_name}
                              </span>
                              <span className="text-zinc-600">·</span>
                              <span className="text-zinc-500">
                                {incident.occurrences_count}{' '}
                                {pluralizeRu(
                                  incident.occurrences_count,
                                  'повтор',
                                  'повтора',
                                  'повторов'
                                )}
                              </span>
                              <span className="text-zinc-600">·</span>
                              <span
                                title={formatExactTime(incident.last_occurred_at)}
                                className="text-zinc-500"
                              >
                                {formatRelativeTime(incident.last_occurred_at)}
                              </span>

                              {/* Автор закрытия (Step 3: resolved_by) */}
                              {isResolved && (
                                <>
                                  <span className="text-zinc-600">·</span>
                                  <span
                                    className="text-zinc-400"
                                    title={
                                      incident.resolved_at
                                        ? formatExactTime(incident.resolved_at)
                                        : undefined
                                    }
                                  >
                                    Решено:{' '}
                                    <strong className="text-zinc-200 font-medium">
                                      {incident.resolved_by || 'дежурный'}
                                    </strong>
                                    {incident.resolved_at
                                      ? ` · ${formatRelativeTime(incident.resolved_at)}`
                                      : ''}
                                  </span>
                                </>
                              )}
                            </div>

                            <p className="text-xs font-semibold text-zinc-100 mt-1">
                              {incident.error_type}
                            </p>
                          </div>

                          <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap">
                            {isAnyDesk && (
                              <a
                                href={`anydesk://${incident.remote_id}`}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-750 text-zinc-200 border border-zinc-700/80 text-xs font-medium"
                              >
                                <ExternalLink className="w-3 h-3 text-zinc-400" />
                                <span>AnyDesk: {incident.remote_id}</span>
                              </a>
                            )}
                            {isRuDesktop && (
                              <button
                                onClick={() =>
                                  copyToClipboard(incident.remote_id!, `modal-ru-${incident.id}`)
                                }
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-zinc-800 text-zinc-300 border border-zinc-700 text-xs cursor-pointer"
                              >
                                <span>RuDesktop: {incident.remote_id}</span>
                              </button>
                            )}

                            {!isResolved ? (
                              <button
                                onClick={() => setIncidentToResolve(incident)}
                                disabled={isResolving}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-950/60 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800/80 text-xs font-medium cursor-pointer disabled:opacity-50"
                              >
                                <Check className="w-3 h-3 text-emerald-400" />
                                <span>{isResolving ? 'Сохранение...' : 'Починено'}</span>
                              </button>
                            ) : (
                              <button
                                onClick={() => executeReopen(incident.id)}
                                disabled={isResolving}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-zinc-850 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 border border-zinc-750 text-xs cursor-pointer transition-colors disabled:opacity-50"
                                title="Вернуть в работу"
                              >
                                <RotateCcw className="w-3 h-3 text-zinc-400" />
                                <span>{isResolving ? 'Возврат...' : 'Вернуть в работу'}</span>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* AI-Triage в досье */}
                        {incident.ai_diagnosis && (
                          <div className="p-2.5 rounded-md bg-zinc-900 border border-zinc-800 space-y-1 text-xs">
                            <div className="flex items-center gap-1 text-zinc-400 font-medium">
                              <Sparkles className="w-3 h-3 text-zinc-400" />
                              <span>Рекомендация по устранению</span>
                            </div>
                            <p className="text-zinc-200">{incident.ai_diagnosis}</p>
                            {incident.ai_actions && (
                              <pre className="text-zinc-400 font-mono text-[11px] whitespace-pre-wrap pt-1 mt-1 border-t border-zinc-800">
                                {incident.ai_actions}
                              </pre>
                            )}
                          </div>
                        )}

                        {/* Стек ошибки */}
                        <details className="group text-xs">
                          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300 flex items-center gap-1 select-none text-[11px]">
                            <ChevronDown className="w-3 h-3 group-open:rotate-180 transition-transform" />
                            <span>Стек ошибки 1С</span>
                          </summary>
                          <div className="mt-1.5 p-2 rounded-md bg-zinc-900 border border-zinc-850 font-mono text-[11px] text-zinc-400 whitespace-pre-wrap overflow-x-auto">
                            {incident.raw_error}
                          </div>
                        </details>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Подвал модалки досье */}
            <div className="p-3.5 border-t border-zinc-800 bg-zinc-950 flex items-center justify-between text-xs">
              <button
                onClick={() => {
                  const shopToFilter = inspectedShopName;
                  setInspectedShopName(null);
                  setSelectedShopFilter(shopToFilter);
                  setIncidentStatusFilter('ALL');
                  setActiveTab('incidents');
                }}
                className="inline-flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
              >
                <span>Перейти во вкладку «Сбои»</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={() => setInspectedShopName(null)}
                className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-750 text-zinc-200 cursor-pointer transition-colors"
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. Модальное окно подтверждения «Починено» */}
      {incidentToResolve && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div
            className="bg-zinc-900 border border-zinc-800 rounded-lg max-w-sm w-full p-4 space-y-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-md bg-emerald-950/40 border border-emerald-800/40 flex items-center justify-center text-emerald-400">
                  <Check className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-xs font-semibold text-zinc-100">
                    Отметить сбой как решенный
                  </h3>
                  <p className="text-[11px] text-zinc-500">Снятие инцидента с активного контроля</p>
                </div>
              </div>
              <button
                onClick={() => setIncidentToResolve(null)}
                className="text-zinc-500 hover:text-zinc-300 p-1 cursor-pointer"
                title="Отмена"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3 rounded-md bg-zinc-950 border border-zinc-850 text-xs text-zinc-300 space-y-1">
              <p className="leading-relaxed">
                Закрыть инцидент на точке{' '}
                <strong className="text-zinc-100">{incidentToResolve.shop_name}</strong> (
                {incidentToResolve.workplace_name})?
              </p>
              <div className="pt-1 text-[11px] text-zinc-500 truncate">
                Ошибка: {incidentToResolve.error_type}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1 text-xs">
              <button
                type="button"
                onClick={() => setIncidentToResolve(null)}
                className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-750 text-zinc-300 hover:text-zinc-100 cursor-pointer transition-colors"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => executeResolve(incidentToResolve.id)}
                className="px-3.5 py-1.5 rounded-md bg-emerald-950/80 hover:bg-emerald-900/80 text-emerald-300 border border-emerald-800/80 font-medium cursor-pointer transition-colors flex items-center gap-1.5"
              >
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span>Отметить как решенный</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. Модальное окно подтверждения паузы опроса сети (Kill-Switch) */}
      {killSwitchModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl p-5 text-zinc-200 space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div
                  className={`p-2 rounded-md ${
                    killSwitchActive
                      ? 'bg-zinc-800 text-zinc-300 border border-zinc-700'
                      : 'bg-rose-950/40 text-rose-400 border border-rose-800/60'
                  }`}
                >
                  <PowerOff className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-100">
                    {killSwitchActive
                      ? 'Возобновление опроса сети'
                      : 'Приостановка опроса сети'}
                  </h3>
                  <p className="text-xs text-zinc-500">
                    Сервисная пауза для касс 1С
                  </p>
                </div>
              </div>
              <button
                onClick={() => setKillSwitchModalOpen(false)}
                className="text-zinc-500 hover:text-zinc-300 p-1 cursor-pointer"
                title="Закрыть"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="text-xs leading-relaxed text-zinc-300 p-3.5 rounded-md bg-zinc-950 border border-zinc-850">
              {killSwitchActive ? (
                <div className="space-y-1.5">
                  <p className="text-zinc-200">
                    Возобновить сбор телеметрии со всех касс сети в штатном режиме?
                  </p>
                  <p className="text-emerald-400 text-[11px]">
                    Кассы возобновят отправку телеметрии и проверку обновлений каждые 10 минут.
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <p className="text-zinc-200">
                    Приостановить сбор телеметрии со всех касс на 24 часа?
                  </p>
                  <p className="text-zinc-400 text-[11px]">
                    При следующем запросе кассы получат директиву паузы и перейдут в режим ожидания на 24 часа.
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-1 text-xs">
              <button
                type="button"
                onClick={() => setKillSwitchModalOpen(false)}
                disabled={killSwitchLoading}
                className="px-3.5 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-750 text-zinc-300 cursor-pointer transition-colors"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleToggleKillSwitch}
                disabled={killSwitchLoading}
                className={`px-4 py-1.5 rounded-md font-medium cursor-pointer transition-colors flex items-center gap-1.5 ${
                  killSwitchActive
                    ? 'bg-zinc-100 hover:bg-white text-zinc-900'
                    : 'bg-rose-950/80 hover:bg-rose-900/80 text-rose-300 border border-rose-800/80'
                }`}
              >
                {killSwitchLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                <span>
                  {killSwitchActive
                    ? 'Возобновить сбор'
                    : 'Приостановить сбор'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 6. Модальное окно «Журнал действий» (Audit Log Modal) */}
      {auditModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-6 bg-black/75 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden shadow-2xl">
            {/* Шапка модалки */}
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-950">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-300">
                  <History className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-zinc-100">Журнал действий смены</h2>
                  <p className="text-xs text-zinc-500">Последние 50 событий в системе аудита</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={fetchAuditLogs}
                  disabled={auditLoading}
                  className="p-1.5 rounded-md bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 cursor-pointer transition-colors"
                  title="Обновить журнал"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${auditLoading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => setAuditModalOpen(false)}
                  className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850 cursor-pointer transition-colors"
                  title="Закрыть (Esc)"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Список записей аудита */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2 text-xs">
              {auditLoading && auditLogs.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-zinc-500 gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Загрузка журнала...</span>
                </div>
              ) : auditLogs.length === 0 ? (
                <div className="text-center py-12 text-zinc-500">
                  <History className="w-6 h-6 mx-auto mb-2 opacity-50" />
                  <p>Журнал действий пуст</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {auditLogs.map((log) => {
                    const actionInfo = formatAuditAction(log.action);

                    return (
                      <div
                        key={log.id}
                        className="p-2.5 rounded-md bg-zinc-950/70 border border-zinc-850 flex items-start justify-between gap-3"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className={`font-medium ${actionInfo.color}`}>
                              {actionInfo.label}
                            </span>
                            <span className="text-zinc-600">·</span>
                            <span className="text-zinc-300 font-mono">{log.username}</span>
                          </div>
                          {log.details && (
                            <p className="text-zinc-400 text-[11px] leading-relaxed">
                              {log.details}
                            </p>
                          )}
                        </div>

                        <div className="text-right whitespace-nowrap text-zinc-500 text-[11px] pt-0.5">
                          <span title={formatExactTime(log.created_at)}>
                            {formatRelativeTime(log.created_at)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Подвал модалки */}
            <div className="p-3 border-t border-zinc-800 bg-zinc-950 flex items-center justify-between text-xs text-zinc-500">
              <span>Записей в буфере: {auditLogs.length}</span>
              <button
                onClick={() => setAuditModalOpen(false)}
                className="px-3 py-1 rounded-md bg-zinc-800 hover:bg-zinc-750 text-zinc-200 cursor-pointer transition-colors"
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
