import Head from 'next/head';
import { useState } from 'react';
import { useRouter } from 'next/router';

export default function LoginPage() {
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const form = new FormData(e.target);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: form.get('username'),
        password: form.get('password'),
      }),
    });
    if (res.ok) {
      router.push('/data');
    } else {
      setError('Invalid username or password');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 [&_button:not(:disabled)]:cursor-pointer">
      <Head>
        <title>Login – Pingwi</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <h1 className="text-lg font-semibold text-gray-900 mb-5">Admin login</h1>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Username
              </label>
              <input
                name="username"
                type="text"
                autoComplete="username"
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/20"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Password
              </label>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/20"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-black text-white text-sm font-medium py-2 rounded-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
