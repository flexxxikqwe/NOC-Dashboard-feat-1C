import { NextRequest, NextResponse } from 'next/server';
import {
  extractClientIp,
  checkRateLimit,
  recordFailedAttempt,
  resetRateLimit,
} from '@/lib/rate-limiter';
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  type UserRole,
} from '@/lib/session';
import { getUserByUsername, hashPassword, logAudit } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const ip = extractClientIp(req);

  // 1. Проверка лимита попыток входа
  const limitStatus = checkRateLimit(ip);
  if (!limitStatus.allowed) {
    return NextResponse.json(
      {
        error:
          limitStatus.errorMessage ||
          'Слишком много попыток входа. IP заблокирован на 15 минут',
        retryAfterSeconds: limitStatus.retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(limitStatus.retryAfterSeconds || 900),
        },
      }
    );
  }

  // 2. Разбор учетных данных
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Некорректное тело запроса.' },
      { status: 400 }
    );
  }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!username || !password) {
    return NextResponse.json(
      { error: 'Введите логин и пароль' },
      { status: 400 }
    );
  }

  // 3. Проверка пользователя в базе данных (users)
  const dbUser = getUserByUsername(username);
  let authenticatedUser: { username: string; role: UserRole } | null = null;

  if (dbUser) {
    const inputHash = hashPassword(password);
    if (dbUser.password_hash === inputHash) {
      authenticatedUser = { username: dbUser.username, role: dbUser.role };
    }
  } else {
    // Резервная проверка через переменные окружения (.env)
    const expectedEnvUsername = process.env.DASHBOARD_USERNAME || 'admin';
    const expectedEnvPassword = process.env.DASHBOARD_PASSWORD || 'admin';
    if (username === expectedEnvUsername && password === expectedEnvPassword) {
      authenticatedUser = { username, role: 'ADMIN' };
    }
  }

  if (!authenticatedUser) {
    const attemptResult = recordFailedAttempt(ip);
    if (attemptResult.blocked) {
      return NextResponse.json(
        {
          error:
            attemptResult.errorMessage ||
            'Слишком много попыток входа. IP заблокирован на 15 минут',
          retryAfterSeconds: attemptResult.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(attemptResult.retryAfterSeconds || 900),
          },
        }
      );
    }

    return NextResponse.json(
      {
        error: 'Неверный логин или пароль',
        remainingAttempts: attemptResult.remainingAttempts,
      },
      { status: 401 }
    );
  }

  // 4. Сброс счетчика блокировок и выдача сессионного токена с ролью
  resetRateLimit(ip);
  const sessionToken = await createSessionToken(
    authenticatedUser.username,
    authenticatedUser.role
  );

  // 5. Запись в журнал аудита
  logAudit(
    authenticatedUser.username,
    'LOGIN',
    `Вход под ролью ${authenticatedUser.role === 'ADMIN' ? 'Администратор' : 'Инженер'}`
  );

  const response = NextResponse.json(
    {
      success: true,
      message: 'Успешная авторизация',
      user: {
        username: authenticatedUser.username,
        role: authenticatedUser.role,
      },
    },
    { status: 200 }
  );

  // Установка куки сессии с едиными опциями
  response.cookies.set(SESSION_COOKIE_NAME, sessionToken, SESSION_COOKIE_OPTIONS);

  return response;
}
