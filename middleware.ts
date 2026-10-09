import { NextRequest, NextResponse } from 'next/server';
import { hasValidSessionFormat, SESSION_COOKIE_NAME } from '@/lib/session';

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

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1. Публичные маршруты (доступны без авторизации)
  const isPublic =
    pathname === '/login' ||
    pathname === '/api/v1/auth/login' ||
    pathname === '/api/v1/auth/logout' ||
    pathname === '/api/v1/telemetry' ||
    pathname === '/api/v1/version' ||
    pathname.startsWith('/downloads/') ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico';

  if (isPublic) {
    // Если пользователь уже авторизован и заходит на /login -> редирект на дашборд /
    if (pathname === '/login') {
      const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
      if (hasValidSessionFormat(sessionCookie)) {
        return NextResponse.redirect(new URL('/', req.url));
      }
    }
    return NextResponse.next();
  }

  // 2. Проверка валидности структуры и срока действия сессионной куки
  const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const isValid = hasValidSessionFormat(sessionCookie);

  if (!isValid) {
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
