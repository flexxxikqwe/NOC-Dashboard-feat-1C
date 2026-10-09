import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const session = await getSessionUser(req);
    if (!session) {
      return NextResponse.json(
        { error: 'Не авторизован' },
        { status: 401 }
      );
    }

    return NextResponse.json(
      {
        username: session.username,
        role: session.role,
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: 'Внутренняя ошибка проверки сессии', details: String(error) },
      { status: 500 }
    );
  }
}
