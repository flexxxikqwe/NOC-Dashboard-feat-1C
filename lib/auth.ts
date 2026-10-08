export const DEFAULT_TELEMETRY_BEARER_TOKEN = 'dev-secret-token-2026';
export const MAX_PAYLOAD_BYTES = 65536; // 64 KB

/**
 * Validates the Authorization header against the configured TELEMETRY_BEARER_TOKEN.
 * Uses process.env.TELEMETRY_BEARER_TOKEN with fallback to DEFAULT_TELEMETRY_BEARER_TOKEN.
 */
export function verifyBearerToken(authHeader: string | null): boolean {
  if (!authHeader) {
    return false;
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return false;
  }

  const providedToken = parts[1];
  const expectedToken = process.env.TELEMETRY_BEARER_TOKEN || DEFAULT_TELEMETRY_BEARER_TOKEN;

  // Constant-time-like comparison without leaking length
  if (providedToken.length !== expectedToken.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < providedToken.length; i++) {
    result |= providedToken.charCodeAt(i) ^ expectedToken.charCodeAt(i);
  }

  return result === 0;
}
