/**
 * User-scoped local preference keys keep shared-device room layouts private.
 * A preference is never read or persisted before the room identity is known.
 */
export function roomWorkspacePreferenceKey(
  roomId: string,
  userId: string | null | undefined,
  preference: string,
) {
  if (!roomId || !userId || !preference) return null;
  return `omnilume:room:${roomId}:${userId}:${preference}`;
}
