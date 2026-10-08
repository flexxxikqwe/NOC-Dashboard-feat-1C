import { NextRequest, NextResponse } from 'next/server';
import { verifyBearerToken, MAX_PAYLOAD_BYTES } from '@/lib/auth';
import db, { generateWorkplaceId, generateErrorHash } from '@/lib/db';
import { triageIncident } from '@/lib/ai-triage';
import type { TelemetryPayload, TelemetryResponse } from '@/types/telemetry';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // 1. Payload Guard: Content-Length check
  const contentLengthHeader = req.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength) && contentLength > MAX_PAYLOAD_BYTES) {
      return NextResponse.json(
        { error: 'Payload Too Large. Maximum allowed size is 64 KB.' },
        { status: 413 }
      );
    }
  }

  // 2. Authorization check
  const authHeader = req.headers.get('authorization');
  if (!verifyBearerToken(authHeader)) {
    return NextResponse.json(
      { error: 'Unauthorized. Invalid or missing Bearer token.' },
      { status: 401 }
    );
  }

  // 3. Read raw body and double check byte size against MAX_PAYLOAD_BYTES
  let rawBodyText: string;
  try {
    rawBodyText = await req.text();
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read request body', details: String(err) },
      { status: 400 }
    );
  }

  const byteLength = Buffer.byteLength(rawBodyText, 'utf8');
  if (byteLength > MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      { error: 'Payload Too Large. Maximum allowed size is 64 KB.' },
      { status: 413 }
    );
  }

  // 4. Parse JSON payload
  let body: TelemetryPayload;
  try {
    body = JSON.parse(rawBodyText) as TelemetryPayload;
  } catch {
    return NextResponse.json(
      { error: 'Malformed JSON payload.' },
      { status: 400 }
    );
  }

  // Basic validation of required fields
  if (!body || typeof body.shop !== 'string' || typeof body.workplace !== 'string' || !body.remote) {
    return NextResponse.json(
      { error: 'Invalid payload: "shop", "workplace", and "remote" are required.' },
      { status: 422 }
    );
  }

  const nowIso = new Date().toISOString();
  const workplaceId = generateWorkplaceId(body.shop, body.workplace);

  const remoteType = body.remote.type || 'NONE';
  const remoteId = body.remote.id ? String(body.remote.id).trim() : null;
  const systemInfoJson = body.system_info ? JSON.stringify(body.system_info) : null;

  // 5. Structure incident candidates to triage and persist
  interface IncidentItemToProcess {
    errorHash: string;
    errorType: string;
    severity: string;
    rawError: string;
  }

  const itemsToProcess: IncidentItemToProcess[] = [];

  // 5.1 Extract runtime_errors
  if (Array.isArray(body.runtime_errors)) {
    for (const err of body.runtime_errors) {
      if (!err || typeof err.error_text !== 'string') {
        continue;
      }
      const eventName = err.event ? String(err.event).trim() : 'RuntimeError';
      const rawErrorText = String(err.error_text).trim();
      const errorHash = generateErrorHash(eventName, rawErrorText);

      itemsToProcess.push({
        errorHash,
        errorType: eventName,
        severity: 'ERROR',
        rawError: rawErrorText,
      });
    }
  }

  // 5.2 Extract health_checks
  if (Array.isArray(body.health_checks)) {
    for (const check of body.health_checks) {
      if (!check || !check.id) {
        continue;
      }
      const checkStatus = String(check.status).toUpperCase();
      if (checkStatus === 'ERROR' || checkStatus === 'WARN') {
        const checkId = String(check.id).trim();
        const details = String(check.details || check.name || 'Health check issue').trim();
        const errorHash = generateErrorHash(`health_check_${checkId}`, details);
        const severity = checkStatus === 'WARN' ? 'WARN' : 'ERROR';

        itemsToProcess.push({
          errorHash,
          errorType: checkId,
          severity,
          rawError: details,
        });
      }
    }
  }

  // 6. Check existing active incidents in SQLite to decide whether AI-Triage is needed
  // Prepared statements for lookups and mutations
  const findActiveIncidentStmt = db.prepare(`
    SELECT id, occurrences_count, ai_diagnosis, ai_actions
    FROM incidents
    WHERE workplace_id = ? AND error_hash = ? AND status = 'ACTIVE'
    LIMIT 1
  `);

  interface PreparedIncidentAction {
    item: IncidentItemToProcess;
    existingId?: number;
    triage?: { diagnosis: string | null; actions: string | null };
  }

  const actionsPlan: PreparedIncidentAction[] = [];

  for (const item of itemsToProcess) {
    const existing = findActiveIncidentStmt.get(workplaceId, item.errorHash) as
      | { id: number; occurrences_count: number; ai_diagnosis: string | null; ai_actions: string | null }
      | undefined;

    if (existing) {
      // Существующий инцидент: инкрементируем счетчик без вызова ИИ
      actionsPlan.push({
        item,
        existingId: existing.id,
      });
    } else {
      // Новый инцидент: вызываем AI-Triage (с кэшированием внутри triageIncident)
      const triage = await triageIncident(item.errorType, item.rawError, item.errorHash);
      actionsPlan.push({
        item,
        triage,
      });
    }
  }

  // 7. Atomic transaction for database persistence
  let incidentsRecorded = 0;

  const ingestTransaction = db.transaction(() => {
    // 7.1 Upsert workplace
    const upsertWorkplaceStmt = db.prepare(`
      INSERT INTO workplaces (
        id,
        shop_name,
        workplace_name,
        remote_type,
        remote_id,
        system_info_json,
        last_seen
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        shop_name = excluded.shop_name,
        workplace_name = excluded.workplace_name,
        remote_type = excluded.remote_type,
        remote_id = excluded.remote_id,
        system_info_json = COALESCE(excluded.system_info_json, workplaces.system_info_json),
        last_seen = excluded.last_seen;
    `);

    upsertWorkplaceStmt.run(
      workplaceId,
      body.shop.trim(),
      body.workplace.trim(),
      remoteType,
      remoteId,
      systemInfoJson,
      nowIso
    );

    const updateIncidentStmt = db.prepare(`
      UPDATE incidents
      SET occurrences_count = occurrences_count + 1,
          last_occurred_at = ?
      WHERE id = ?
    `);

    const insertIncidentStmt = db.prepare(`
      INSERT INTO incidents (
        workplace_id,
        error_hash,
        error_type,
        severity,
        raw_error,
        ai_diagnosis,
        ai_actions,
        status,
        created_at,
        last_occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
    `);

    for (const plan of actionsPlan) {
      if (plan.existingId) {
        updateIncidentStmt.run(nowIso, plan.existingId);
      } else {
        insertIncidentStmt.run(
          workplaceId,
          plan.item.errorHash,
          plan.item.errorType,
          plan.item.severity,
          plan.item.rawError,
          plan.triage?.diagnosis ?? null,
          plan.triage?.actions ?? null,
          nowIso,
          nowIso
        );
      }
      incidentsRecorded++;
    }
  });

  try {
    ingestTransaction();
  } catch (dbError) {
    console.error('[INGESTION API ERROR]', dbError);
    return NextResponse.json(
      { error: 'Internal Database Error', details: String(dbError) },
      { status: 500 }
    );
  }

  // 8. Directive Bus response
  const responseData: TelemetryResponse = {
    success: true,
    workplace_id: workplaceId,
    incidents_recorded: incidentsRecorded,
    config: {
      next_check_seconds: 600,
      ota_enabled: true,
    },
  };

  return NextResponse.json(responseData, { status: 200 });
}
