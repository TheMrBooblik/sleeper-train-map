import { NextResponse } from 'next/server';

const COOKIE = 'admin_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function verifyToken(token, secret) {
  if (!token || !secret) return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const hmacHex = token.slice(0, dot);
  const timestamp = token.slice(dot + 1);

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Date.now() - ts > MAX_AGE_MS) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const hmacBytes = new Uint8Array(
    hmacHex.match(/.{2}/g).map((b) => parseInt(b, 16))
  );

  return crypto.subtle.verify('HMAC', key, hmacBytes, enc.encode(timestamp));
}

export async function middleware(request) {
  const { pathname } = request.nextUrl;

  if (pathname === '/data') {
    const token = request.cookies.get(COOKIE)?.value;
    const valid = await verifyToken(token, process.env.ADMIN_SESSION_SECRET);
    if (!valid) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  // Only protect the /data admin page, not the public static files under /data/*
  matcher: ['/data'],
};
