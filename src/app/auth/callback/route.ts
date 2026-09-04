import { createClient } from '@/utils/supabase/server';
import {
  DEFAULT_AUTH_REDIRECT,
  PROFILE_SETUP_PATH,
  getSafeRedirectPath,
} from '@/lib/auth';
import { NextResponse, type NextRequest } from 'next/server';

function callbackErrorResponse(request: NextRequest, nextPath: string) {
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('error', 'oauth_callback');
  loginUrl.searchParams.set('next', nextPath);
  return NextResponse.redirect(loginUrl);
}

export async function GET(request: NextRequest) {
  const nextPath = getSafeRedirectPath(
    request.nextUrl.searchParams.get('next'),
    DEFAULT_AUTH_REDIRECT,
  );
  const code = request.nextUrl.searchParams.get('code');

  if (!code) return callbackErrorResponse(request, nextPath);

  const supabase = await createClient();
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) return callbackErrorResponse(request, nextPath);

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return callbackErrorResponse(request, nextPath);

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('profile_completed')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError || profile?.profile_completed !== true) {
    const setupUrl = new URL(PROFILE_SETUP_PATH, request.url);
    setupUrl.searchParams.set('next', nextPath);
    return NextResponse.redirect(setupUrl);
  }

  return NextResponse.redirect(new URL(nextPath, request.url));
}
