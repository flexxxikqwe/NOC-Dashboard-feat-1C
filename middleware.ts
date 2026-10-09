import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/session';

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

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1. Публичные маршруты (НЕ блокируются сессией)
  if (
    pathname === '/login' ||
    pathname === '/api/v1/auth/login' ||
    pathname === '/api/v1/auth/logout' ||
    pathname === '/api/v1/telemetry' ||
    pathname === '/api/v1/version' ||
    pathname.startsWith('/downloads/') ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico'
  ) {
    // Если пользователь уже авторизован и заходит на /login -> редирект на дашборд /
    if (pathname === '/login') {
      const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
      const session = await verifySessionToken(sessionCookie);
      if (session.valid) {
        return NextResponse.redirect(new URL('/', req.url));
      }
    }
    return NextResponse.next();
  }

  // 2. Проверка сессионной куки для всех защищенных маршрутов
  const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(sessionCookie);

  if (!session.valid) {
    // Для API запросов возвращаем JSON 401
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Требуется авторизация в пульте NOC' },
        { status: 401 }
      );
    }

    // Для браузерных страниц редиректим на /login
    const loginUrl = new URL('/login', req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}
