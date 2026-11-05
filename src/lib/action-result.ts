// Server Action results.
//
// In production React replaces any error thrown by a Server Action with a
// generic "Minified React error #441" before it reaches the browser, so a
// thrown message ("You do not have permission…", "expected version does not
// match") never arrives. Actions therefore return their outcome as data, and
// callers unwrap it, which re-throws a normal client-side Error carrying the
// original message. Existing try/catch blocks in components keep working.

import { unstable_rethrow } from 'next/navigation';

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

const MAX_ERROR_CHARS = 300;

function publicMessage(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const clean = message.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_CHARS);
  return clean || 'Something went wrong. Please try again.';
}

// Runs a Server Action body and returns its result or its error message.
// Next.js control-flow errors (redirect, notFound, request-time API bailouts)
// are re-thrown so the framework still handles them.
export async function actionResult<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, error: publicMessage(error) };
  }
}

export function unwrapAction<T>(result: ActionResult<T>): T {
  if (!result || typeof result !== 'object' || !('ok' in result)) {
    throw new Error('Unexpected response from the server.');
  }
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
