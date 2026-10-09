/**
 * Session management utility using Web Crypto HMAC-SHA256.
 * Zero external dependencies. Compatible with both Node.js and Edge runtimes.
 */
import type { NextRequest } from 'next/server';

export type UserRole = 'ADMIN' | 'ENGINEER';

export interface SessionData {
  valid: boolean;
  username?: string;
  role?: UserRole;
}

export const SESSION_COOKIE_NAME = 'noc_auth_session';
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 дней

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
 * Verifies a session token string.
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

      if (computedSignatureHex !== providedSignatureHex) {
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

      if (computedSignatureHex !== providedSignatureHex) {
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
