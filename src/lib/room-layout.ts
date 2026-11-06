// Adaptive room workspace (Action 09): pure layout rules shared by the room
// page, the Room Control Center and tests. No imports.

export const ROOM_LAYOUTS = ['balanced', 'stage', 'chat'] as const;
export type RoomLayout = (typeof ROOM_LAYOUTS)[number];

export const ROOM_LAYOUT_DETAILS: Record<RoomLayout, { label: string; description: string }> = {
  balanced: { label: 'Balanced', description: 'Chat sits in the centre at room home and moves beside the stage when a feature opens.' },
  stage: { label: 'Stage focus', description: 'The open feature fills the room. Chat opens on demand.' },
  chat: { label: 'Chat focus', description: 'A wide chat beside a smaller stage.' },
};

// Must match room_control_settings_theme_check (migration 20261105190000).
export const ROOM_THEMES = ['violet', 'ocean', 'emerald', 'amber', 'rose', 'graphite'] as const;
export type RoomTheme = (typeof ROOM_THEMES)[number];
export const ROOM_THEME_LABELS: Record<RoomTheme, string> = {
  violet: 'Violet',
  ocean: 'Ocean',
  emerald: 'Emerald',
  amber: 'Amber',
  rose: 'Rose',
  graphite: 'Graphite',
};

export type RoomActivity = 'home' | 'watch' | 'study' | 'whiteboard';
export type RoomFeatureFlags = Partial<Record<'chat' | 'watch' | 'files' | 'study' | 'announcements', boolean>>;
// Action 12 adds Voice (voice, screen share, raise hand, consented recording)
// and Collaborate (polls, countdowns, events, search) side tools.
export type RoomTool = 'chat' | 'members' | 'files' | 'voice' | 'collab';

export type RoomAppearance = { defaultLayout: RoomLayout; layoutLocked: boolean; theme: RoomTheme };
export const DEFAULT_ROOM_APPEARANCE: RoomAppearance = { defaultLayout: 'balanced', layoutLocked: false, theme: 'violet' };

export function isRoomLayout(value: unknown): value is RoomLayout {
  return typeof value === 'string' && (ROOM_LAYOUTS as readonly string[]).includes(value);
}

export function isRoomTheme(value: unknown): value is RoomTheme {
  return typeof value === 'string' && (ROOM_THEMES as readonly string[]).includes(value);
}

export function appearanceFromSettings(settings: { default_layout?: unknown; layout_locked?: unknown; theme?: unknown } | null | undefined): RoomAppearance {
  return {
    defaultLayout: isRoomLayout(settings?.default_layout) ? settings.default_layout : DEFAULT_ROOM_APPEARANCE.defaultLayout,
    layoutLocked: settings?.layout_locked === true,
    theme: isRoomTheme(settings?.theme) ? settings.theme : DEFAULT_ROOM_APPEARANCE.theme,
  };
}

// A locked room uses the owner's preset; otherwise a member's own choice
// wins, falling back to the room default.
export function effectiveLayout(appearance: RoomAppearance, personal: unknown): RoomLayout {
  if (appearance.layoutLocked) return appearance.defaultLayout;
  return isRoomLayout(personal) ? personal : appearance.defaultLayout;
}

// The room theme applies unless the member picked their own.
export function effectiveTheme(appearance: RoomAppearance, personal: unknown): RoomTheme {
  return isRoomTheme(personal) ? personal : appearance.theme;
}

export function featureForActivity(activity: RoomActivity): 'watch' | 'study' | null {
  if (activity === 'watch') return 'watch';
  if (activity === 'study' || activity === 'whiteboard') return 'study';
  return null;
}

export function isFeatureEnabled(flags: RoomFeatureFlags, feature: keyof RoomFeatureFlags) {
  return flags[feature] !== false;
}

// A disabled feature never leaves an empty stage: the room falls back home.
export function effectiveActivity(requested: RoomActivity, flags: RoomFeatureFlags): RoomActivity {
  const feature = featureForActivity(requested);
  return feature && !isFeatureEnabled(flags, feature) ? 'home' : requested;
}

// Likewise a disabled side tool falls back to an available one.
export function effectiveTool(requested: RoomTool, flags: RoomFeatureFlags): RoomTool {
  if (requested === 'chat' && !isFeatureEnabled(flags, 'chat')) return 'members';
  if (requested === 'files' && !isFeatureEnabled(flags, 'files')) return isFeatureEnabled(flags, 'chat') ? 'chat' : 'members';
  // Voice and Collaborate ride on the chat feature (chat capability server-side).
  if ((requested === 'voice' || requested === 'collab') && !isFeatureEnabled(flags, 'chat')) return 'members';
  return requested;
}
