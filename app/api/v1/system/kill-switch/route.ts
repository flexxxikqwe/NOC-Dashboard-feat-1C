import { NextRequest, NextResponse } from 'next/server';
import { getKillSwitchState, setKillSwitch, logAudit } from '@/lib/db';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const state = getKillSwitchState();
    return NextResponse.json(
      {
        kill_switch_active: state.active,
        active: state.active,
        updated_at: state.updated_at,
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: 'Ошибка получения состояния паузы сети', details: String(error) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    // 1. Проверка прав пользователя (RBAC)
    const session = await getSessionUser(req);
    if (!session) {
      return NextResponse.json(
        { error: 'Требуется авторизация' },
        { status: 401 }
      );
    }

    if (session.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Недостаточно прав. Настройка доступна только администраторам' },
        { status: 403 }
      );
    }

    // 2. Определение целевого состояния
    let targetActive: boolean | undefined;

    try {
      const body = await req.json();
      if (typeof body.active === 'boolean') {
        targetActive = body.active;
      }
    } catch {
      // Тело пустое или не JSON
    }

    if (typeof targetActive !== 'boolean') {
      const current = getKillSwitchState();
      targetActive = !current.active;
    }

    // 3. Сохранение настройки
    const updatedState = setKillSwitch(targetActive);

    // 4. Фиксация в журнале аудита
    logAudit(
      session.username,
      'TOGGLE_PAUSE',
      targetActive ? 'Пауза сети: ВКЛ (24ч)' : 'Пауза сети: ВЫКЛ (штатный режим)'
    );

    return NextResponse.json(
      {
        success: true,
        kill_switch_active: updatedState.active,
        active: updatedState.active,
        updated_at: updatedState.updated_at,
        message: updatedState.active
          ? 'Пауза опроса активирована. Кассы переведены в спящий режим на 24 часа.'
          : 'Пауза опроса отключена. Кассы вернулись в штатный режим опроса.',
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: 'Ошибка изменения состояния паузы сети', details: String(error) },
      { status: 500 }
    );
  }
}
