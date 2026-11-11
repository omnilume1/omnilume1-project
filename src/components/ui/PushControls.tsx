'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { dismissPushOffer, disablePush, enablePush, getPushState, pushConfigured, shouldOfferPush, type PushState } from '@/lib/push-client';

const noSubscription = () => () => undefined;

/** Settings → Account: notifications on this device, on or off. Uses the settings row classes passed in. */
export function PushSettingsRow({ classes }: { classes: { row: string; rowText: string; rowControl: string } }) {
  const [state, setState] = useState<PushState | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getPushState().then((next) => { if (active) setState(next); });
    return () => { active = false; };
  }, []);

  const toggle = async () => {
    setBusy(true);
    setNote(null);
    if (state === 'on') {
      await disablePush();
    } else {
      const result = await enablePush();
      if (!result.ok && result.reason === 'failed') setNote('Could not turn notifications on. Please try again.');
    }
    setState(await getPushState());
    setBusy(false);
  };

  // Not set up for this deployment yet (no VAPID key): no row, rather than a row that cannot work.
  if (!pushConfigured) return null;
  const detail = state === 'on' ? 'Messages, mentions and room updates reach this device, even when OmniLume is closed.'
    : state === 'denied' ? 'Notifications are blocked for OmniLume. To allow them: Android Settings → Apps → OmniLume → Notifications (or the lock icon in your browser\'s address bar), then come back here.'
    : state === 'unsupported' ? 'This browser cannot receive notifications from OmniLume.'
    : 'Get notified when friends message or mention you, even when OmniLume is closed.';
  return (
    <div className={classes.row}>
      <div className={classes.rowText}>
        <strong>Notifications on this device</strong>
        <small>{detail}</small>
        {note && <small role="alert">{note}</small>}
      </div>
      <div className={classes.rowControl}>
        {(state === 'on' || state === 'off') && (
          <button type="button" className="omni-button omni-button-ghost omni-button-sm" onClick={() => void toggle()} disabled={busy} aria-pressed={state === 'on'}>
            {busy ? 'Working…' : state === 'on' ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>
    </div>
  );
}

/** Notification bell: a one-time, dismissible offer, shown only while the browser has never been asked. */
export function PushOfferRow() {
  const offered = useSyncExternalStore(noSubscription, shouldOfferPush, () => false);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!offered || gone) return null;
  return (
    <div className="notification-popover-footer">
      <p className="notification-popover-footer-title">Get notified when friends message you</p>
      <span>
        <button type="button" className="notification-popover-text-button" disabled={busy} onClick={() => { setBusy(true); void enablePush().then(() => { dismissPushOffer(); setGone(true); }); }}>Turn on</button>
        {' '}
        <button type="button" className="notification-popover-text-button" disabled={busy} onClick={() => { dismissPushOffer(); setGone(true); }}>Not now</button>
      </span>
    </div>
  );
}
