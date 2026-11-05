export type MusicShortcut = 'toggle' | 'next' | 'previous' | 'volumeUp' | 'volumeDown' | 'search' | 'escape';

type ShortcutTarget = { tagName?: string; isContentEditable?: boolean; getAttribute?: (name: string) => string | null } | null;
export type ShortcutEvent = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: ShortcutTarget };

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const ACTIVATING_ROLES = new Set(['button', 'link', 'slider', 'menuitem', 'tab', 'checkbox', 'switch']);

/** Every shortcut is ignored while typing; Space also yields to a focused control. */
export function musicShortcutFor(event: ShortcutEvent): MusicShortcut | null {
  const target = event.target;
  const tag = target?.tagName?.toUpperCase() ?? '';
  if (TYPING_TAGS.has(tag) || target?.isContentEditable) return null;
  const mod = event.metaKey || event.ctrlKey;
  if (event.altKey) return null;

  if (event.key === 'Escape') return 'escape';
  if (!mod && event.key === '/') return 'search';
  if (!mod && event.key === ' ') {
    const role = target?.getAttribute?.('role') ?? '';
    return tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || ACTIVATING_ROLES.has(role) ? null : 'toggle';
  }
  if (!mod) return null;
  if (event.key === 'ArrowRight') return 'next';
  if (event.key === 'ArrowLeft') return 'previous';
  if (event.key === 'ArrowUp') return 'volumeUp';
  if (event.key === 'ArrowDown') return 'volumeDown';
  if (event.key.toLowerCase() === 'f') return 'search';
  return null;
}
