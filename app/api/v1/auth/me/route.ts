import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';
import { isKillSwitchActive } from '@/lib/db';

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

    // Проверка статуса Kill-Switch:
    // Если аварийный режим активен, инженерам (ENGINEER) доступ блокируется с 403 Forbidden.
    // Администраторы (ADMIN) имеют непрерывный доступ.
    const killActive = isKillSwitchActive();
    if (session.role === 'ENGINEER' && killActive) {
      return NextResponse.json(
        {
          error:
            'Доступ приостановлен: активен аварийный режим сети (Kill Switch). Обратитесь к администратору.',
          killSwitchActive: true,
          username: session.username,
          role: session.role,
        },
        { status: 403 }
      );
    }

    return NextResponse.json(
      {
        username: session.username,
        role: session.role,
        killSwitchActive: killActive,
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
