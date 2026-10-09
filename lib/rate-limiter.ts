/**
 * In-memory IP-based rate limiter for login brute-force protection.
 * - Maximum 5 failed attempts within 5 minutes.
 * - 15-minute lock upon exceeding the limit.
 */

interface AttemptRecord {
  failures: number;
  windowStart: number;
  blockedUntil: number | null;
}

const ATTEMPTS_MAP = new Map<string, AttemptRecord>();

const MAX_FAILURES = 5;
const WINDOW_MS = 5 * 60 * 1000; // 5 минут
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 минут

/**
 * Extracts client IP from Next.js / Node Request or Headers.
 */
export function extractClientIp(req: Request): string {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const firstIp = forwardedFor.split(',')[0].trim();
    if (firstIp) return firstIp;
  }

  const realIp = req.headers.get('x-real-ip');
  if (realIp && realIp.trim()) {
    return realIp.trim();
  }

  return '127.0.0.1';
}

/**
 * Checks if the given IP is currently blocked or allowed to attempt login.
 */
export function checkRateLimit(ip: string): {
  allowed: boolean;
  remainingAttempts: number;
  retryAfterSeconds?: number;
  errorMessage?: string;
} {
  const now = Date.now();
  const record = ATTEMPTS_MAP.get(ip);

  if (!record) {
    return { allowed: true, remainingAttempts: MAX_FAILURES };
  }

  // Check if currently blocked
  if (record.blockedUntil !== null) {
    if (now < record.blockedUntil) {
      const retryAfterSeconds = Math.max(1, Math.ceil((record.blockedUntil - now) / 1000));
      return {
        allowed: false,
        remainingAttempts: 0,
        retryAfterSeconds,
        errorMessage: 'Слишком много попыток входа. IP заблокирован на 15 минут',
      };
    }
    // Block duration expired - reset
    ATTEMPTS_MAP.delete(ip);
    return { allowed: true, remainingAttempts: MAX_FAILURES };
  }

  // Check sliding window
  if (now - record.windowStart > WINDOW_MS) {
    ATTEMPTS_MAP.delete(ip);
    return { allowed: true, remainingAttempts: MAX_FAILURES };
  }

  const remaining = Math.max(0, MAX_FAILURES - record.failures);
  return { allowed: true, remainingAttempts: remaining };
}

/**
 * Records a failed login attempt for the given IP.
 * Returns information on whether the IP is now blocked.
 */
export function recordFailedAttempt(ip: string): {
  blocked: boolean;
  remainingAttempts: number;
  retryAfterSeconds?: number;
  errorMessage?: string;
} {
  const now = Date.now();
  let record = ATTEMPTS_MAP.get(ip);

  if (!record || now - record.windowStart > WINDOW_MS) {
    record = {
      failures: 1,
      windowStart: now,
      blockedUntil: null,
    };
    ATTEMPTS_MAP.set(ip, record);
    return {
      blocked: false,
      remainingAttempts: MAX_FAILURES - 1,
    };
  }

  record.failures += 1;

  if (record.failures >= MAX_FAILURES) {
    record.blockedUntil = now + BLOCK_DURATION_MS;
    const retryAfterSeconds = Math.ceil(BLOCK_DURATION_MS / 1000);
    return {
      blocked: true,
      remainingAttempts: 0,
      retryAfterSeconds,
      errorMessage: 'Слишком много попыток входа. IP заблокирован на 15 минут',
    };
  }

  return {
    blocked: false,
    remainingAttempts: MAX_FAILURES - record.failures,
  };
}

/**
 * Resets the attempt counter for an IP upon successful login.
 */
export function resetRateLimit(ip: string): void {
  ATTEMPTS_MAP.delete(ip);
}
