import { NextRequest, NextResponse } from 'next/server';
import db, { logAudit } from '@/lib/db';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const params = await context.params;
    const incidentId = parseInt(params.id, 10);

    if (Number.isNaN(incidentId) || incidentId <= 0) {
      return NextResponse.json(
        { error: 'Некорректный идентификатор инцидента' },
        { status: 400 }
      );
    }

    // Извлечение текущего пользователя из сессии
    const session = await getSessionUser(req);
    const reopenedBy = session?.username || 'дежурный';

    const updateStmt = db.prepare(`
      UPDATE incidents 
      SET status = 'ACTIVE', 
          resolved_at = NULL,
          resolved_by = NULL
      WHERE id = ?;
    `);

    const result = updateStmt.run(incidentId);

    if (result.changes === 0) {
      return NextResponse.json(
        { error: `Инцидент #${incidentId} не найден` },
        { status: 404 }
      );
    }

    // Фиксация в журнале аудита
    logAudit(reopenedBy, 'REOPEN_INCIDENT', `Инцидент #${incidentId} возвращен в работу`);

    return NextResponse.json(
      {
        success: true,
        incident_id: incidentId,
        status: 'ACTIVE',
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[REOPEN INCIDENT ERROR]', error);
    return NextResponse.json(
      {
        error: 'Внутренняя ошибка сервера при возврате инцидента в работу',
        details: String(error),
      },
      { status: 500 }
    );
  }
}
