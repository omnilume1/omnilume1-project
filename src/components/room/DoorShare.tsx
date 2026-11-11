'use client';

import { useEffect, useRef, useState } from 'react';
import { OmniIcon } from '@/components/ui/OmniIcon';
import { isDoorToken } from '@/lib/door-key';
import { DOOR_SHARE_HELP, doorShareData, doorShareUrl, shareDoorLink, type DoorShareOutcome } from '@/lib/door-share';
import { logProductEventFromBrowser } from '@/lib/product-events';
import { createClient } from '@/utils/supabase/client';

// Phase 07: "Send the link". The door token lives in memory only, fetched
// through the browser client's rpc. Bump refreshKey to re-fetch it (the lock
// changed); until the new token arrives the button stays disabled, so an old
// link is never shared.

type DoorTokenState = { key: string; token: string | null; failed: boolean };

export function useDoorToken(roomId: string | null, refreshKey: number) {
  const key = roomId ? `${roomId}:${refreshKey}` : '';
  const [state, setState] = useState<DoorTokenState>({ key: '', token: null, failed: false });

  useEffect(() => {
    if (!roomId) return;
    let active = true;
    void (async () => {
      try {
        const { data, error } = await createClient().rpc('get_room_door_link', { p_room_id: roomId });
        if (active) setState({ key, token: !error && isDoorToken(data) ? data : null, failed: Boolean(error) || !isDoorToken(data) });
      } catch {
        if (active) setState({ key, token: null, failed: true });
      }
    })();
    return () => { active = false; };
  }, [key, roomId]);

  return state.key === key && key ? { token: state.token, failed: state.failed } : { token: null, failed: false };
}

const TOAST_COPY: Partial<Record<DoorShareOutcome, string>> = {
  copied: 'Link copied. Paste it in your group.',
  failed: "Couldn't share or copy the link. Try again.",
};

export function SendLinkButton({ roomId, nameplate, door, size = 'header' }: {
  roomId: string;
  nameplate: string | null;
  door: { token: string | null; failed: boolean };
  size?: 'header' | 'large';
}) {
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  const showToast = (message: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(null), 4_000);
  };

  // No await before shareDoorLink: it calls navigator.share in this tap.
  const send = () => {
    if (!door.token) return;
    const data = doorShareData(nameplate, doorShareUrl(window.location.origin, door.token));
    void shareDoorLink(navigator, data).then((outcome) => {
      if (outcome === 'shared') void logProductEventFromBrowser(createClient(), 'share_completed', { roomId });
      const message = TOAST_COPY[outcome];
      if (message) showToast(message);
    });
  };

  const label = door.token ? 'Send the link' : door.failed ? "Link isn't available" : 'Getting the link…';
  return (
    <>
      <button
        type="button"
        onClick={send}
        disabled={!door.token}
        aria-describedby={`door-share-help-${size}`}
        title={DOOR_SHARE_HELP}
        className={size === 'large' ? 'omni-button omni-button-primary disabled:cursor-wait disabled:opacity-60' : 'room-action disabled:cursor-wait disabled:opacity-60'}
      >
        <OmniIcon name="share" size={15} /><span>{label}</span>
      </button>
      <span id={`door-share-help-${size}`} className={size === 'large' ? 'block text-sm text-neutral-400' : 'hidden max-w-[15rem] text-[11px] leading-4 text-neutral-500 2xl:block'}>{DOOR_SHARE_HELP}</span>
      {toast && (
        <div className="personal-message-toast-stack" aria-live="polite">
          <p className="personal-message-toast" role="status"><OmniIcon name="link" size={15} />{toast}</p>
        </div>
      )}
    </>
  );
}

export function NewRoomShareCard({ roomId, nameplate, door, onDismiss }: {
  roomId: string;
  nameplate: string | null;
  door: { token: string | null; failed: boolean };
  onDismiss: () => void;
}) {
  return (
    <section className="glass-strong relative rounded-2xl p-6 sm:p-8" aria-labelledby="new-room-share-title">
      <button type="button" onClick={onDismiss} className="icon-button absolute right-3 top-3" aria-label="Dismiss"><OmniIcon name="close" size={16} /></button>
      <p className="text-[10px] font-bold uppercase tracking-[.16em] text-violet-300">{nameplate ? `Room ${nameplate}` : 'Your room'} is ready</p>
      <h2 id="new-room-share-title" className="mt-2 text-2xl font-semibold text-white sm:text-3xl">Send the link to your group</h2>
      <div className="mt-5 grid justify-items-start gap-3">
        <SendLinkButton roomId={roomId} nameplate={nameplate} door={door} size="large" />
      </div>
    </section>
  );
}
