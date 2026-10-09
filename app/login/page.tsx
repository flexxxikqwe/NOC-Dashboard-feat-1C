'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Lock, User, AlertCircle, ArrowRight, Loader2 } from 'lucide-react';

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

      // Успешный вход: переход на главную страницу панели
      window.location.href = '/';
    } catch {
      setErrorMessage('Сетевая ошибка при обращении к серверу.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col justify-center items-center p-4 selection:bg-zinc-800 selection:text-zinc-200">
      <div className="w-full max-w-sm">
        {/* Заголовок */}
        <div className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 mb-3 shadow-sm">
            <Activity className="w-5 h-5 text-zinc-300" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
            Мониторинг 1С
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Вход в панель дежурного инженера
          </p>
        </div>

        {/* Карточка формы входа */}
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-6 shadow-xl shadow-black/40 backdrop-blur-sm">
          {/* Сообщение об ошибке */}
          {errorMessage && (
            <div className="mb-4 p-3 rounded-lg bg-red-950/40 border border-red-900/50 text-red-300 text-xs flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1 leading-relaxed">
                <div>{errorMessage}</div>
                {remainingAttempts !== null && (
                  <div className="mt-1 text-[11px] text-red-400/80">
                    Осталось попыток: <span className="font-medium text-red-200">{remainingAttempts}</span> из 5
                  </div>
                )}
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Поле Имя пользователя */}
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-zinc-400" />
                <span>Имя пользователя</span>
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
                placeholder="admin"
                className="w-full px-3 py-2 bg-zinc-950/70 border border-zinc-800 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600 transition-colors"
              />
            </div>

            {/* Поле Пароль */}
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5 flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 text-zinc-400" />
                <span>Пароль</span>
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className="w-full px-3 py-2 bg-zinc-950/70 border border-zinc-800 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600 transition-colors"
              />
            </div>

            {/* Кнопка входа */}
            <button
              type="submit"
              disabled={loading}
              className="w-full mt-2 py-2 px-4 bg-zinc-100 hover:bg-white active:bg-zinc-200 text-zinc-900 text-sm font-medium rounded-lg flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm cursor-pointer"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-zinc-700" />
                  <span>Вход...</span>
                </>
              ) : (
                <>
                  <span>Войти</span>
                  <ArrowRight className="w-4 h-4 text-zinc-600" />
                </>
              )}
            </button>
          </form>

          {/* Подсказка */}
          <div className="mt-5 pt-4 border-t border-zinc-800/80 flex items-center justify-between text-xs text-zinc-400">
            <span>Учетные записи: admin / engineer</span>
            <span>Лимит: 5 попыток</span>
          </div>
        </div>

        {/* Футер */}
        <p className="mt-6 text-center text-xs text-zinc-400">
          Панель мониторинга касс • NOC
        </p>
      </div>
    </div>
  );
}
