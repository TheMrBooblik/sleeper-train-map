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

// Node-runtime verification of a session token (the middleware has its own
// Edge/WebCrypto copy). Used by API routes, which the middleware matcher does
// not cover, to gate writes behind the same admin_session cookie.
export function verifySessionToken(token, secret = process.env.ADMIN_SESSION_SECRET) {
  if (!token || !secret) return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const hmacHex = token.slice(0, dot);
  const timestamp = token.slice(dot + 1);

  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Date.now() - ts > SESSION_MAX_AGE * 1000) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(timestamp)
    .digest('hex');
  return timingSafeCompare(hmacHex, expected);
}
