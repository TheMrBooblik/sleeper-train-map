import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  hashPassword,
  timingSafeCompare,
  createSessionToken,
} from '../../../lib/adminAuth';

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { username, password } = req.body ?? {};

  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedHash = process.env.ADMIN_PASSWORD_HASH;

  if (!expectedUser || !expectedHash) {
    return res.status(503).json({ error: 'Admin credentials not configured' });
  }

  const userMatch = username === expectedUser;
  const passHash = hashPassword(String(password ?? ''));
  const passMatch = timingSafeCompare(passHash, expectedHash);

  if (!userMatch || !passMatch) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = createSessionToken();
  const secure = process.env.NODE_ENV !== 'development';
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=${token}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Strict; Max-Age=${SESSION_MAX_AGE}; Path=/`,
  ]);

  res.status(200).json({ ok: true });
}
