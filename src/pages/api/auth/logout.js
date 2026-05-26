import { SESSION_COOKIE } from '../../../lib/adminAuth';

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const secure = process.env.NODE_ENV !== 'development';
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Strict; Max-Age=0; Path=/`,
  ]);

  res.status(200).json({ ok: true });
}
