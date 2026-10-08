import { NextResponse } from 'next/server';
import db from '@/lib/db';
import type { RemoteType } from '@/types/telemetry';

export const dynamic = 'force-dynamic';

export interface DashboardIncidentRow {
  id: number;
  workplace_id: string;
  error_hash: string;
  error_type: string;
  severity: string;
  raw_error: string;
  ai_diagnosis: string | null;
  ai_actions: string | null;
  occurrences_count: number;
  status: string;
  created_at: string;
  last_occurred_at: string;
  shop_name: string;
  workplace_name: string;
  remote_type: RemoteType;
  remote_id: string | null;
}

export interface DashboardWorkplaceRow {
  id: string;
  shop_name: string;
  workplace_name: string;
  remote_type: RemoteType;
  remote_id: string | null;
  last_seen: string;
  is_online: boolean;
  active_incidents_count: number;
  system_info: Record<string, unknown> | null;
}

export async function GET() {
  try {
    const now = Date.now();
    const ONLINE_THRESHOLD_MS = 15 * 60 * 1000; // 15 минут

    // 1. Извлекаем активные инциденты со связью с рабочими местами
    const incidentsQuery = db.prepare(`
      SELECT 
        i.id,
        i.workplace_id,
        i.error_hash,
        i.error_type,
        i.severity,
        i.raw_error,
        i.ai_diagnosis,
        i.ai_actions,
        i.occurrences_count,
        i.status,
        i.created_at,
        i.last_occurred_at,
        w.shop_name,
        w.workplace_name,
        w.remote_type,
        w.remote_id
      FROM incidents i
      JOIN workplaces w ON i.workplace_id = w.id
      WHERE i.status = 'ACTIVE'
      ORDER BY datetime(i.last_occurred_at) DESC
    `);

    const incidents = incidentsQuery.all() as DashboardIncidentRow[];

    // 2. Извлекаем все рабочие места и количество активных инцидентов для каждого
    const workplacesQuery = db.prepare(`
      SELECT 
        w.id,
        w.shop_name,
        w.workplace_name,
        w.remote_type,
        w.remote_id,
        w.system_info_json,
        w.last_seen,
        COALESCE(SUM(CASE WHEN i.status = 'ACTIVE' THEN 1 ELSE 0 END), 0) AS active_incidents_count
      FROM workplaces w
      LEFT JOIN incidents i ON w.id = i.workplace_id
      GROUP BY w.id
      ORDER BY w.shop_name ASC, w.workplace_name ASC
    `);

    interface RawWorkplaceDbRow {
      id: string;
      shop_name: string;
      workplace_name: string;
      remote_type: RemoteType;
      remote_id: string | null;
      system_info_json: string | null;
      last_seen: string;
      active_incidents_count: number;
    }

    const rawWorkplaces = workplacesQuery.all() as RawWorkplaceDbRow[];

    const workplaces: DashboardWorkplaceRow[] = rawWorkplaces.map((wp) => {
      const lastSeenMs = new Date(wp.last_seen).getTime();
      const isOnline = !Number.isNaN(lastSeenMs) && (now - lastSeenMs) <= ONLINE_THRESHOLD_MS;

      let parsedSystemInfo: Record<string, unknown> | null = null;
      if (wp.system_info_json) {
        try {
          parsedSystemInfo = JSON.parse(wp.system_info_json);
        } catch {
          parsedSystemInfo = null;
        }
      }

      return {
        id: wp.id,
        shop_name: wp.shop_name,
        workplace_name: wp.workplace_name,
        remote_type: wp.remote_type,
        remote_id: wp.remote_id,
        last_seen: wp.last_seen,
        is_online: isOnline,
        active_incidents_count: wp.active_incidents_count,
        system_info: parsedSystemInfo,
      };
    });

    return NextResponse.json(
      {
        success: true,
        incidents,
        workplaces,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        },
      }
    );
  } catch (error) {
    console.error('[DASHBOARD DATA API ERROR]', error);
    return NextResponse.json(
      { error: 'Failed to retrieve dashboard telemetry', details: String(error) },
      { status: 500 }
    );
  }
}
