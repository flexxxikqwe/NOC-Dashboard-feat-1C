'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, Lock, User, AlertCircle, Terminal, ArrowRight, Loader2 } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [remainingAttempts, setRemainingAttempts] = useState<number | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setLoading(true);

    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || 'Ошибка входа в систему.');
        if (typeof data.remainingAttempts === 'number') {
          setRemainingAttempts(data.remainingAttempts);
        } else {
          setRemainingAttempts(null);
        }
        return;
      }

      // Успешный вход: переход на главную страницу пульта
      router.push('/');
      router.refresh();
    } catch {
      setErrorMessage('Сетевая ошибка при обращении к серверу авторизации.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100 flex flex-col justify-center items-center p-4 selection:bg-red-950 selection:text-red-200">
      {/* Фоновый индустриальный паттерн */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.15),rgba(255,255,255,0))] pointer-events-none" />

      <div className="w-full max-w-md relative z-10">
        {/* Заголовок пульта */}
        <div className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-lg bg-zinc-900 border border-zinc-800 text-red-500 mb-3 shadow-lg shadow-black/50">
            <Terminal className="w-6 h-6" />
          </div>
          <h1 className="text-xl md:text-2xl font-bold font-mono tracking-tight text-white flex items-center justify-center gap-2">
            1C NOC CONTROL CENTER
          </h1>
          <p className="text-xs text-zinc-400 mt-1 font-mono">
            Авторизованный доступ к пульту мониторинга кассовых узлов
          </p>
        </div>

        {/* Карточка формы авторизации */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 shadow-2xl backdrop-blur">
          {/* Индикатор защищенного контура */}
          <div className="flex items-center justify-between pb-4 mb-5 border-b border-zinc-800 text-xs font-mono">
            <div className="flex items-center gap-2 text-zinc-400">
              <Shield className="w-4 h-4 text-emerald-500" />
              <span>ЗАЩИЩЕННЫЙ КОНТУР</span>
            </div>
            <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 text-[10px] uppercase font-mono">
              NOC SEC v1.0
            </span>
          </div>

          {/* Сообщение об ошибке */}
          {errorMessage && (
            <div className="mb-5 p-3 rounded bg-red-950/70 border border-red-800 text-red-200 text-xs flex items-start gap-2.5 animate-in fade-in">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1 leading-relaxed">
                <div className="font-semibold">{errorMessage}</div>
                {remainingAttempts !== null && (
                  <div className="mt-1 text-[11px] text-red-300/80">
                    Осталось попыток: <span className="font-bold text-white">{remainingAttempts}</span> из 5
                  </div>
                )}
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Поле Логин */}
            <div>
              <label className="block text-xs font-mono uppercase text-zinc-400 mb-1.5 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-zinc-500" />
                <span>Имя оператора (Логин)</span>
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
                placeholder="admin"
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 font-mono transition-colors"
              />
            </div>

            {/* Поле Пароль */}
            <div>
              <label className="block text-xs font-mono uppercase text-zinc-400 mb-1.5 flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 text-zinc-500" />
                <span>Пароль доступа</span>
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="••••••••••••"
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 font-mono transition-colors"
              />
            </div>

            {/* Кнопка входа */}
            <button
              type="submit"
              disabled={loading}
              className="w-full mt-2 py-2.5 px-4 bg-red-600 hover:bg-red-500 active:bg-red-700 text-white font-mono text-xs uppercase tracking-wider font-semibold rounded flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-red-950/40 cursor-pointer"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Проверка учетных данных...</span>
                </>
              ) : (
                <>
                  <span>Войти в пульт</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {/* Подсказка для администратора и инженера */}
          <div className="mt-5 pt-4 border-t border-zinc-800/80 flex flex-col gap-1 text-[11px] font-mono text-zinc-500">
            <div className="flex items-center justify-between">
              <span>Доступ: admin / admin (Админ) &bull; engineer / engineer</span>
              <span>Rate-Limit: 5/5 мин</span>
            </div>
          </div>
        </div>

        {/* Футер */}
        <p className="mt-4 text-center text-[11px] text-zinc-600 font-mono">
          NOC 1C Service Desk &copy; {new Date().getFullYear()} &bull; Все права защищены
        </p>
      </div>
    </div>
  );
}
