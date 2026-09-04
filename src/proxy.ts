import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSafeRedirectPath, isAuthRequiredPath, PROFILE_SETUP_PATH } from '@/lib/auth';

function redirectWithSessionCookies(url: URL, sessionResponse: NextResponse) {
  const response = NextResponse.redirect(url);
  sessionResponse.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
  return response;
}

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            supabaseResponse.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const requiresAuth = isAuthRequiredPath(pathname);

  if (requiresAuth && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    loginUrl.searchParams.set(
      'next',
      getSafeRedirectPath(`${pathname}${request.nextUrl.search}`),
    );
    return redirectWithSessionCookies(loginUrl, supabaseResponse);
  }

  if (requiresAuth && user) {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('profile_completed')
      .eq('id', user.id)
      .maybeSingle();
    const profileComplete = !profileError && profile?.profile_completed === true;

    if (pathname === PROFILE_SETUP_PATH) {
      if (profileComplete) {
        const requestedNext = getSafeRedirectPath(request.nextUrl.searchParams.get('next'));
        const destination = requestedNext === PROFILE_SETUP_PATH ? '/home' : requestedNext;
        return redirectWithSessionCookies(new URL(destination, request.url), supabaseResponse);
      }
      return supabaseResponse;
    }

    if (!profileComplete) {
      const setupUrl = request.nextUrl.clone();
      setupUrl.pathname = PROFILE_SETUP_PATH;
      setupUrl.search = '';
      setupUrl.searchParams.set(
        'next',
        getSafeRedirectPath(`${pathname}${request.nextUrl.search}`),
      );
      return redirectWithSessionCookies(setupUrl, supabaseResponse);
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
