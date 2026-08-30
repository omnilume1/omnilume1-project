'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  
  const router = useRouter();
  const supabase = createClient();

  const handleAuth = async (e: React.FormEvent, type: 'login' | 'signup') => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg('');

    try {
      const { error } = type === 'login' 
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

      if (error) {
        setErrorMsg(error.message);
      } else {
        // Redirect to our secure messages page upon success
        router.push('/messages');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
      <div className="w-full max-w-sm border border-neutral-800 bg-[#0a0a0a] p-8 rounded-2xl shadow-2xl">
        <h1 className="text-2xl font-bold mb-2">Omnilume Auth</h1>
        <p className="text-sm text-neutral-400 mb-6">Sign in to access secure features.</p>

        {errorMsg && (
          <div className="mb-4 p-3 bg-red-950/50 border border-red-900 rounded text-red-400 text-xs">
            {errorMsg}
          </div>
        )}

        <form className="flex flex-col gap-4">
          <div>
            <label className="block text-xs uppercase text-neutral-500 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-[#050505] border border-neutral-800 rounded px-3 py-2 text-sm focus:border-neutral-500 outline-none"
              placeholder="user@test.com"
              required
            />
          </div>
          <div>
            <label className="block text-xs uppercase text-neutral-500 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-[#050505] border border-neutral-800 rounded px-3 py-2 text-sm focus:border-neutral-500 outline-none"
              placeholder="••••••••"
              required
            />
          </div>

          <div className="flex gap-3 mt-4">
            <button
              onClick={(e) => handleAuth(e, 'login')}
              disabled={loading || !email || !password}
              className="flex-1 py-2 bg-neutral-800 text-white rounded text-sm hover:bg-neutral-700 transition"
            >
              {loading ? '...' : 'Log In'}
            </button>
            <button
              onClick={(e) => handleAuth(e, 'signup')}
              disabled={loading || !email || !password}
              className="flex-1 py-2 bg-white text-black font-semibold rounded text-sm hover:bg-neutral-200 transition"
            >
              {loading ? '...' : 'Create Account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}