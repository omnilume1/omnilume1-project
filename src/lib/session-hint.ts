// Supabase's session cookie (readable by design: the browser client uses it), split into .0/.1 chunks
// when large. Only a hint for which landing nav to show; /api/account is what confirms the session.
export const SESSION_COOKIE = /(?:^|;\s*)sb-[^=;]+-auth-token(?:\.\d+)?=/;

// Inline on the static landing, before first paint, so signed-in visitors never see the guest nav.
export const ACCOUNT_HINT_SCRIPT = `try{if(${SESSION_COOKIE}.test(document.cookie))document.documentElement.dataset.account=''}catch(e){}`;
