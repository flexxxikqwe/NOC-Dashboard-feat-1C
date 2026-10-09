import { NextResponse } from 'next/server';
import { getAuditLogs } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const logs = getAuditLogs(50);
    return NextResponse.json(
      {
        success: true,
        logs,
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: 'Ошибка загрузки журнала аудита', details: String(error) },
      { status: 500 }
    );
  }
}
