import { NextRequest, NextResponse } from 'next/server';
import { verifyBearerToken } from '@/lib/auth';
import { cleanupOldIncidents } from '@/lib/cleaner';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // Проверка авторизации: Bearer токен обязателен
  const authHeader = req.headers.get('authorization');
  if (!verifyBearerToken(authHeader)) {
    return NextResponse.json(
      { error: 'Unauthorized. Invalid or missing Bearer token.' },
      { status: 401 }
    );
  }

  try {
    let retentionDays = 14;

    // Опционально принимаем кастомный retention_days из тела запроса
    try {
      const body = await req.json();
      if (body && typeof body.retention_days === 'number' && body.retention_days > 0) {
        retentionDays = Math.floor(body.retention_days);
      }
    } catch {
      // Пустое тело запроса считается корректным вызовом с дефолтом 14 дней
    }

    const result = cleanupOldIncidents(retentionDays);

    return NextResponse.json(
      {
        success: true,
        deleted_count: result.deleted_count,
        retention_days: retentionDays,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[MAINTENANCE CLEANUP ERROR]', error);
    return NextResponse.json(
      { error: 'Internal Error during cleanup execution', details: String(error) },
      { status: 500 }
    );
  }
}
