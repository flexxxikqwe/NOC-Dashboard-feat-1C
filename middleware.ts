import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, hasValidSessionFormat } from '@/lib/session';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1. Статика Next.js
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/static') ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
  }

  // 2. Внешние клиенты (1C, агенты, крон) с заголовком Authorization: Bearer
  const authHeader = req.headers.get('authorization') || '';
  if (authHeader.startsWith('Bearer ') || authHeader.startsWith('bearer ')) {
    return NextResponse.next();
  }

  // 3. Публичные маршруты (телеметрия, очистка, логин, статика загрузок и т.д.)
  // Проверяем startsWith для надежной поддержки query-параметров и вложенных путей
  const isPublicRoute =
    pathname === '/login' ||
    pathname.startsWith('/api/v1/auth/login') ||
    pathname.startsWith('/api/v1/auth/logout') ||
    pathname.startsWith('/api/v1/telemetry') ||
    pathname.startsWith('/api/v1/version') ||
    pathname.startsWith('/api/v1/maintenance') ||
    pathname.startsWith('/downloads');

  if (isPublicRoute) {
    // Если пользователь уже авторизован и заходит на /login -> редирект на главную
    if (pathname === '/login') {
      const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
      if (hasValidSessionFormat(sessionCookie)) {
        return NextResponse.redirect(new URL('/', req.url));
      }
    }
    return NextResponse.next();
  }

  // 4. Проверка сессионной куки для всех остальных маршрутов
  const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const isValid = hasValidSessionFormat(sessionCookie);

  if (!isValid) {
    // API возвращает 401 JSON
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Требуется авторизация в пульте NOC' },
        { status: 401 }
      );
    }

    // Браузер редиректится на /login
    const loginUrl = new URL('/login', req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for static assets:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
