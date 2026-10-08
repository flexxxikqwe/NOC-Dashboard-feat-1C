import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const params = await context.params;
    const incidentId = parseInt(params.id, 10);

    if (Number.isNaN(incidentId) || incidentId <= 0) {
      return NextResponse.json(
        { error: 'Invalid incident ID parameter' },
        { status: 400 }
      );
    }

    const updateStmt = db.prepare(`
      UPDATE incidents
      SET status = 'RESOLVED'
      WHERE id = ?
    `);

    const result = updateStmt.run(incidentId);

    if (result.changes === 0) {
      return NextResponse.json(
        { error: `Incident #${incidentId} not found` },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        incident_id: incidentId,
        status: 'RESOLVED',
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[RESOLVE INCIDENT ERROR]', error);
    return NextResponse.json(
      { error: 'Internal Error while resolving incident', details: String(error) },
      { status: 500 }
    );
  }
}
