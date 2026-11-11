// "Send the link" (hostel roadmap phase 07): the door-key share URL, the share
// sheet text, and share-or-copy. No imports and no DOM types, so the unit
// tests load this module directly. The token only ever goes into the /join
// URL handed to the share sheet or clipboard: never into logs, events or a
// /room/... URL.

export const DOOR_SHARE_REF = 'invite';
export const DOOR_SHARE_HELP = 'Anyone with this link can come in. Changed your mind? Change the lock.';

export type DoorShareData = { title: string; text: string; url: string };

export type ShareNavigator = {
  share?: (data: DoorShareData) => Promise<void>;
  clipboard?: { writeText: (text: string) => Promise<void> };
};

export type DoorShareOutcome = 'shared' | 'cancelled' | 'copied' | 'failed';

/** origin + /join/<token>?ref=invite */
export function doorShareUrl(origin: string, token: string) {
  return `${origin.replace(/\/+$/, '')}/join/${token}?ref=${DOOR_SHARE_REF}`;
}

/** What the share sheet shows: "Room B-204 · door's open". */
export function doorShareData(nameplate: string | null | undefined, url: string): DoorShareData {
  const plate = typeof nameplate === 'string' ? nameplate.trim() : '';
  return plate
    ? { title: `Room ${plate}`, text: `Room ${plate} · door's open`, url }
    : { title: 'OmniLume room', text: "Door's open", url };
}

/** A share-sheet failure: the person closing the sheet is not an error; anything else falls back to copying. */
export function shareFailureOutcome(error: unknown): 'cancelled' | 'copy' {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError' ? 'cancelled' : 'copy';
}

/**
 * Opens the share sheet, or copies the URL when there is none or it fails.
 * navigator.share is called synchronously, before any await, so the tap's
 * user activation is still there when it runs. Never rejects.
 */
export function shareDoorLink(nav: ShareNavigator | undefined, data: DoorShareData): Promise<DoorShareOutcome> {
  let sharing: Promise<void>;
  try {
    sharing = typeof nav?.share === 'function' ? nav.share(data) : Promise.reject(new Error('Share sheet unavailable.'));
  } catch (error) {
    sharing = Promise.reject(error);
  }
  return sharing.then(
    () => 'shared' as const,
    async (error: unknown) => {
      if (shareFailureOutcome(error) === 'cancelled') return 'cancelled' as const;
      try {
        if (typeof nav?.clipboard?.writeText !== 'function') return 'failed' as const;
        await nav.clipboard.writeText(data.url);
        return 'copied' as const;
      } catch {
        return 'failed' as const;
      }
    },
  );
}
