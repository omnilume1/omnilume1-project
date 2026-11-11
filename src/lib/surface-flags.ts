// Surfaces hidden from the UI because nobody uses them yet (hostel phase 11).
// Flipping a flag to true restores the surface. No code, data, action or RPC is removed.
export const SURFACES = {
  polls: false,
  countdowns: false,
  studyTasks: false,
  clips: false,
  roomExport: false,
  trustBadges: false,
  groupConversion: false,
  musicSources: false,
  recordings: false,
} as const;
