import crypto from 'crypto';

export const SESSION_COOKIE = 'admin_session';
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // seconds

export function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export function timingSafeCompare(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createSessionToken() {
  const timestamp = Date.now().toString();
  const hmac = crypto
    .createHmac('sha256', process.env.ADMIN_SESSION_SECRET)
    .update(timestamp)
    .digest('hex');
  return `${hmac}.${timestamp}`;
}
