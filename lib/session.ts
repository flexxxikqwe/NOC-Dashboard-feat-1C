/**
 * Session management utility using Web Crypto HMAC-SHA256.
 * Zero external dependencies. Fully compatible with Node.js and Edge runtimes.
 */
import type { NextRequest } from 'next/server';

export type UserRole = 'ADMIN' | 'ENGINEER';

export interface SessionData {
  valid: boolean;
  username?: string;
  role?: UserRole;
}

export const SESSION_COOKIE_NAME = 'noc_auth_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 дней

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_MAX_AGE_SECONDS,
  secure: false, // Базовое значение, динамически переопределяется по протоколу HTTPS
};

const DEFAULT_SECRET = 'noc-dashboard-session-secret-salt-2026-production';
const textEncoder = new TextEncoder();

function getSecretKey(): string {
  return process.env.SESSION_SECRET || DEFAULT_SECRET;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Constant-time comparison for hex strings to avoid timing attacks
 * and prevent buffer length mismatch errors (unlike timingSafeEqual).
 */
export function safeCompareHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Lightweight synchronous check for token structure and expiration.
 * Safe for Edge Runtime middleware without heavy cryptographic operations.
 */
export function hasValidSessionFormat(token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') {
    return false;
  }

  const parts = token.split('.');

  // 4-part token: username.role.expiresAt.signature
  if (parts.length === 4) {
    const [username, role, expiresAtStr, signatureHex] = parts;
    if (!username || (role !== 'ADMIN' && role !== 'ENGINEER')) {
      return false;
    }
    const expiresAt = parseInt(expiresAtStr, 10);
    if (Number.isNaN(expiresAt) || Date.now() > expiresAt) {
      return false;
    }
    if (!signatureHex || signatureHex.length !== 64) {
      return false;
    }
    return true;
  }

  // 3-part legacy token: username.expiresAt.signature
  if (parts.length === 3) {
    const [username, expiresAtStr, signatureHex] = parts;
    if (!username) {
      return false;
    }
    const expiresAt = parseInt(expiresAtStr, 10);
    if (Number.isNaN(expiresAt) || Date.now() > expiresAt) {
      return false;
    }
    if (!signatureHex || signatureHex.length !== 64) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Creates a signed session token: `${username}.${role}.${expiresAt}.${signatureHex}`
 */
export async function createSessionToken(
  username: string,
  role: UserRole = 'ADMIN',
  maxAgeSeconds = SESSION_MAX_AGE_SECONDS
): Promise<string> {
  const expiresAt = Date.now() + maxAgeSeconds * 1000;
  const payload = `${username}:${role}:${expiresAt}`;
  const secret = getSecretKey();
  const key = await importHmacKey(secret);
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(payload)
  );
  const signatureHex = bufferToHex(signatureBuffer);
  return `${username}.${role}.${expiresAt}.${signatureHex}`;
}

/**
 * Verifies a session token string with HMAC-SHA256 signature check.
 * Supports both 4-part (${username}.${role}.${expiresAt}.${signature}) and 3-part legacy tokens.
 */
export async function verifySessionToken(
  token: string | null | undefined
): Promise<SessionData> {
  if (!token || typeof token !== 'string') {
    return { valid: false };
  }

  const parts = token.split('.');

  // Format: username.role.expiresAt.signature
  if (parts.length === 4) {
    const [username, roleRaw, expiresAtStr, providedSignatureHex] = parts;
    const expiresAt = parseInt(expiresAtStr, 10);

    if (Number.isNaN(expiresAt) || Date.now() > expiresAt) {
      return { valid: false };
    }

    const role: UserRole = roleRaw === 'ENGINEER' ? 'ENGINEER' : 'ADMIN';

    try {
      const payload = `${username}:${role}:${expiresAt}`;
      const secret = getSecretKey();
      const key = await importHmacKey(secret);
      const computedBuffer = await crypto.subtle.sign(
        'HMAC',
        key,
        textEncoder.encode(payload)
      );
      const computedSignatureHex = bufferToHex(computedBuffer);

      if (!safeCompareHex(computedSignatureHex, providedSignatureHex)) {
        return { valid: false };
      }

      return { valid: true, username, role };
    } catch {
      return { valid: false };
    }
  }

  // Legacy format: username.expiresAt.signature
  if (parts.length === 3) {
    const [username, expiresAtStr, providedSignatureHex] = parts;
    const expiresAt = parseInt(expiresAtStr, 10);

    if (Number.isNaN(expiresAt) || Date.now() > expiresAt) {
      return { valid: false };
    }

    try {
      const payload = `${username}:${expiresAt}`;
      const secret = getSecretKey();
      const key = await importHmacKey(secret);
      const computedBuffer = await crypto.subtle.sign(
        'HMAC',
        key,
        textEncoder.encode(payload)
      );
      const computedSignatureHex = bufferToHex(computedBuffer);

      if (!safeCompareHex(computedSignatureHex, providedSignatureHex)) {
        return { valid: false };
      }

      return { valid: true, username, role: 'ADMIN' };
    } catch {
      return { valid: false };
    }
  }

  return { valid: false };
}

/**
 * Helper to get user and role from request cookie
 */
export async function getSessionUser(
  req: NextRequest
): Promise<{ username: string; role: UserRole } | null> {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token);
  if (!session.valid || !session.username || !session.role) {
    return null;
  }
  return { username: session.username, role: session.role };
}
