'use server';

import { redirect } from 'next/navigation';
import { joinRoomWithInvite } from '@/actions/room-controls';
import { getLoginPath, getSafeRedirectPath, isProfileComplete, PROFILE_SETUP_PATH } from '@/lib/auth';
import { getCurrentAccount } from '@/lib/current-account';
import { doorNoticeFor, joinFrom, joinPath, type DoorNotice } from '@/lib/join-card';
import { normalizeJoinToken } from '@/lib/join-card-server';
import { cleanRef } from '@/lib/product-events';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function backToDoor(path: string, notice: DoorNotice) {
  return `${path}${path.includes('?') ? '&' : '?'}door=${notice}`;
}

// Where Come in goes next. Never throws, so redirect() below stays outside
// any try/catch.
async function comeInDestination(formData: FormData): Promise<string> {
  const token = normalizeJoinToken(String(formData.get('token') ?? ''));
  if (!token) return '/';
  const ref = cleanRef(formData.get('ref'));
  const door = joinPath(token, ref);

  try {
    const account = await getCurrentAccount();
    if (!account) return getLoginPath(door);
    const complete = isProfileComplete({
      profile_completed: account.profileCompleted,
      profile_details_completed: account.profileDetailsCompleted,
    });
    if (!complete) return `${PROFILE_SETUP_PATH}?next=${encodeURIComponent(getSafeRedirectPath(door))}`;

    // joinRoomWithInvite logs joined / guest_joined for new members only.
    const result = await joinRoomWithInvite(token, ref);
    if (!result.ok) return backToDoor(door, doorNoticeFor(result.error));
    const roomId = String(result.data.room_id ?? '');
    if (!UUID_PATTERN.test(roomId)) return backToDoor(door, 'retry');
    // The token never goes into a /room URL.
    return `/room/${roomId}?from=${joinFrom(result.data.role, ref)}`;
  } catch {
    return backToDoor(door, 'retry');
  }
}

/** Come in (signed in only): joins with the link and opens the room. */
export async function comeIn(formData: FormData): Promise<void> {
  const destination = await comeInDestination(formData);
  redirect(destination);
}
