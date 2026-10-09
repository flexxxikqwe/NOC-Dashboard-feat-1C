import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import process from 'node:process';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_FILE_PATH = path.resolve(process.cwd(), 'storage.db');

async function runTests() {
  console.log('[TEST-AUTH-KILLSWITCH] Running integration tests against:', BASE_URL);

  // 1. Verify unauthenticated access to /api/v1/dashboard/data returns 401
  const unauthRes = await fetch(`${BASE_URL}/api/v1/dashboard/data`);
  console.log('[TEST 1] Unauthenticated /api/v1/dashboard/data status:', unauthRes.status);
  if (unauthRes.status !== 401) {
    throw new Error(`Expected 401 for unauthenticated request, got ${unauthRes.status}`);
  }

  // 2. Test invalid login
  const badLoginRes = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
  });
  console.log('[TEST 2] Invalid login status:', badLoginRes.status);
  const badLoginData = await badLoginRes.json();
  console.log('[TEST 2] Response:', badLoginData);
  if (badLoginRes.status !== 401) {
    throw new Error(`Expected 401 for bad login, got ${badLoginRes.status}`);
  }

  // 3. Test successful login
  const goodLoginRes = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  console.log('[TEST 3] Good login status:', goodLoginRes.status);
  const goodLoginData = await goodLoginRes.json();
  console.log('[TEST 3] Response:', goodLoginData);
  if (goodLoginRes.status !== 200 || !goodLoginData.success) {
    throw new Error(`Expected 200 and success: true, got ${goodLoginRes.status}`);
  }

  const setCookie = goodLoginRes.headers.get('set-cookie');
  console.log('[TEST 3] Received cookie:', setCookie ? 'PRESENT' : 'MISSING');
  if (!setCookie) {
    throw new Error('Expected set-cookie header on successful login');
  }

  const sessionCookie = setCookie.split(';')[0];

  // 4. Test authenticated access to /api/v1/dashboard/data using session cookie
  const authDashRes = await fetch(`${BASE_URL}/api/v1/dashboard/data`, {
    headers: { Cookie: sessionCookie },
  });
  console.log('[TEST 4] Authenticated /api/v1/dashboard/data status:', authDashRes.status);
  if (authDashRes.status !== 200) {
    throw new Error(`Expected 200 for authenticated dashboard request, got ${authDashRes.status}`);
  }

  // 5. Test Kill-Switch initial state
  const ksGetRes = await fetch(`${BASE_URL}/api/v1/system/kill-switch`, {
    headers: { Cookie: sessionCookie },
  });
  const ksGetData = await ksGetRes.json();
  console.log('[TEST 5] Initial Kill-Switch state:', ksGetData);

  // 6. Test telemetry under normal state (kill_switch = false)
  const telRes1 = await fetch(`${BASE_URL}/api/v1/telemetry`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer dev-secret-token-2026',
    },
    body: JSON.stringify({
      shop: 'Тестовый Магазин',
      workplace: 'Касса №1',
      remote: { type: 'ANYDESK', id: '111222333' },
    }),
  });
  const telData1 = await telRes1.json();
  console.log('[TEST 6] Normal telemetry response:', telData1);
  if (telData1.config?.kill_switch) {
    throw new Error('Expected kill_switch to be falsy in normal state');
  }

  // 7. Toggle Kill-Switch to ON
  const ksActivateRes = await fetch(`${BASE_URL}/api/v1/system/kill-switch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ active: true }),
  });
  const ksActivateData = await ksActivateRes.json();
  console.log('[TEST 7] Kill-Switch activated:', ksActivateData);
  if (!ksActivateData.active) {
    throw new Error('Kill switch should be active');
  }

  // 8. Test telemetry under Kill-Switch state
  const telRes2 = await fetch(`${BASE_URL}/api/v1/telemetry`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer dev-secret-token-2026',
    },
    body: JSON.stringify({
      shop: 'Тестовый Магазин',
      workplace: 'Касса №1',
      remote: { type: 'ANYDESK', id: '111222333' },
    }),
  });
  const telData2 = await telRes2.json();
  console.log('[TEST 8] Kill-Switch telemetry response:', telData2);
  if (!telData2.config?.kill_switch || telData2.config?.next_check_seconds !== 86400) {
    throw new Error(`Expected kill_switch: true and next_check_seconds: 86400, got ${JSON.stringify(telData2.config)}`);
  }

  // 9. Reset Kill-Switch back to OFF
  const ksDeactivateRes = await fetch(`${BASE_URL}/api/v1/system/kill-switch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ active: false }),
  });
  const ksDeactivateData = await ksDeactivateRes.json();
  console.log('[TEST 9] Kill-Switch reset:', ksDeactivateData);
  if (ksDeactivateData.active) {
    throw new Error('Kill switch should be inactive');
  }

  // 10. Test logout
  const logoutRes = await fetch(`${BASE_URL}/api/v1/auth/logout`, {
    method: 'POST',
    headers: { Cookie: sessionCookie },
  });
  console.log('[TEST 10] Logout status:', logoutRes.status);

  console.log('\n[SUCCESS] ALL INTEGRATION TESTS PASSED PERFECTLY!');
}

runTests().catch((err) => {
  console.error('[TEST ERROR]', err);
  process.exit(1);
});
