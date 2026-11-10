// The colour the default theme really paints behind every page: base #0e0b14 after the
// theme engine's darkening (measured on the running page as rgb(5, 3, 7)). The web manifest,
// the browser theme colour, the offline page and the Android splash all use it, so app
// start → first paint shows no flash. A unit test fails if the theme engine and this drift apart.
export const APP_SHELL_COLOR = '#050307';

// Home on a phone: how many rows its Friends and Rooms lists had last time on this device,
// so their loading placeholders are already the height the lists are about to be and the
// tiles below do not jump. Only two small numbers, kept in this browser.
export const HOME_ROWS_KEY = 'omnilume:home-rows';
export type HomeRowsKind = 'friends' | 'rooms';
const ROW_HEIGHT = 52;
const MAX_ROWS = 5;

/** The placeholder height for a list of `rows` rows, or null when the stored value is not a row count. */
export function homeRowsHold(rows: unknown): string | null {
  return typeof rows === 'number' && Number.isInteger(rows) && rows >= 0 && rows <= MAX_ROWS ? `${Math.max(21, rows * ROW_HEIGHT - 2)}px` : null;
}

/**
 * Runs in <head> before the first paint and sets --home-friends-hold / --home-rooms-hold on
 * <html>. React cannot do this in time: a paint between the streamed page and hydration
 * showed the small placeholder first. Self-contained and guarded, so a blocked or edited
 * localStorage value only leaves the placeholder at its normal size.
 */
export const HOME_ROWS_BOOT_SCRIPT = `(function(){try{var r=JSON.parse(localStorage.getItem(${JSON.stringify(HOME_ROWS_KEY)})||"{}")||{},s=document.documentElement.style;["friends","rooms"].forEach(function(k){var n=r[k];if(typeof n==="number"&&n%1===0&&n>=0&&n<=${MAX_ROWS})s.setProperty("--home-"+k+"-hold",Math.max(21,n*${ROW_HEIGHT}-2)+"px")})}catch(e){}})()`;
