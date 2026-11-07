'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { OmniIcon } from '@/components/ui/OmniIcon';
import { useNotificationCenter } from '@/hooks/useNotificationCenter';
import {
  bellAccessibleLabel,
  itemStaggerDelay,
  nextFocusIndex,
  notificationHref,
  notificationPresentation,
  notificationRoomName,
  popoverMotion,
  relativeTime,
  unreadBadgeText,
  type NavigationKey,
} from '@/lib/notification-center-model';

type Phase = 'closed' | 'entering' | 'open' | 'closing';

// Notification center bell (Action 08). An anchored popover beside the bell,
// not a modal: spring-like 180 ms enter from the bell, 120 ms exit, staggered
// items (on every device, whatever its reduce-motion setting); Esc / outside click close it and
// focus returns to the bell; arrow keys move between notifications.
export default function NotificationBell({ roomId }: { roomId?: string } = {}) {
  const center = useNotificationCenter();
  const [phase, setPhase] = useState<Phase>('closed');
  const [dndHours, setDndHours] = useState<string>('1');
  const [dndWorking, setDndWorking] = useState(false);
  const [roomMuteWorking, setRoomMuteWorking] = useState(false);
  const roomMuted = roomId ? center.isRoomMuted(roomId) : false;
  const motion = popoverMotion(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoverId = useId();
  const headingId = useId();
  const isVisible = phase !== 'closed';
  const isOpen = phase === 'open' || phase === 'entering';

  const close = useCallback((returnFocus: boolean) => {
    setPhase((current) => (current === 'closed' ? current : 'closing'));
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setPhase('closed'), motion.exitMs);
    if (returnFocus) buttonRef.current?.focus();
  }, [motion.exitMs]);

  const open = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    // Re-opening mid-exit reverses the transition instead of re-mounting.
    setPhase((current) => (current === 'closing' ? 'open' : 'entering'));
    void center.reload();
  }, [center]);

  // Mount in the closed pose for one frame, then animate to open.
  useEffect(() => {
    if (phase !== 'entering') return;
    const frame = window.requestAnimationFrame(() => setPhase('open'));
    return () => window.cancelAnimationFrame(frame);
  }, [phase]);

  useEffect(() => {
    if (phase === 'open') headingRef.current?.focus({ preventScroll: true });
  }, [phase]);

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(true); } };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close, isOpen]);

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = itemRefs.current.findIndex((element) => element === document.activeElement);
    const next = nextFocusIndex(current, center.items.length, event.key as NavigationKey);
    itemRefs.current[next]?.focus();
  };

  const toggleDoNotDisturb = async () => {
    setDndWorking(true);
    await center.setDoNotDisturb(!center.doNotDisturb, center.doNotDisturb ? null : (dndHours === 'off' ? null : Number(dndHours)));
    setDndWorking(false);
  };

  const toggleRoomMute = async () => {
    if (!roomId) return;
    setRoomMuteWorking(true);
    await center.setRoomMuted(roomId, !roomMuted);
    setRoomMuteWorking(false);
  };

  const badge = unreadBadgeText(center.unreadCount);
  const dndUntil = center.doNotDisturb?.muted_until
    ? new Date(center.doNotDisturb.muted_until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  return (
    <div className="notification-bell">
      <button
        ref={buttonRef}
        type="button"
        className="icon-button notification-bell-button"
        aria-label={bellAccessibleLabel(center.unreadCount)}
        title="Notifications"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isVisible ? popoverId : undefined}
        onClick={() => (isOpen ? close(true) : open())}
      >
        <OmniIcon name="bell" />
        {badge && <span className="notification-bell-badge" aria-hidden="true">{badge}</span>}
      </button>

      {isVisible && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          className="notification-popover"
          data-state={phase === 'open' ? 'open' : 'closed'}
          style={{ ['--notification-exit-ms' as string]: `${motion.exitMs}ms` }}
        >
          <div className="notification-popover-header">
            <div>
              <h2 id={headingId} ref={headingRef} tabIndex={-1} className="notification-popover-title">Notifications</h2>
              <p className="notification-popover-subtitle" aria-live="polite">{center.unreadCount > 0 ? `${center.unreadCount} unread` : 'All caught up'}</p>
            </div>
            <button type="button" className="notification-popover-text-button" onClick={() => void center.markRead(null)} disabled={center.unreadCount === 0}>Mark all read</button>
          </div>

          <div className="notification-popover-body">
            {center.status === 'loading' || center.status === 'idle' ? (
              <ul className="notification-popover-list" aria-busy="true" aria-label="Loading notifications">
                {[0, 1, 2].map((index) => <li key={index} className="notification-skeleton" />)}
              </ul>
            ) : center.status === 'error' && center.items.length === 0 ? (
              <div role="alert" className="notification-popover-state">
                <p>{center.error ?? 'Unable to load notifications.'}</p>
                <button type="button" className="notification-popover-text-button" onClick={() => void center.reload()}>Retry</button>
              </div>
            ) : center.items.length === 0 ? (
              <div className="notification-popover-state">
                <OmniIcon name="bell" size={20} />
                <p>You are all caught up.</p>
                <p className="notification-popover-hint">Mentions, replies, announcements and room updates appear here.</p>
              </div>
            ) : (
              <ul className="notification-popover-list" aria-label="Notifications" onKeyDown={onListKeyDown}>
                {center.items.map((item, index) => {
                  const presentation = notificationPresentation(item.notification_type);
                  const roomName = notificationRoomName(item);
                  return (
                    <li key={item.id} className="notification-popover-item" style={{ ['--stagger' as string]: `${itemStaggerDelay(index, false)}ms` }}>
                      <Link
                        ref={(element) => { itemRefs.current[index] = element; }}
                        href={notificationHref(item)}
                        className={`notification-entry ${item.read_at ? '' : 'is-unread'}`}
                        onClick={() => { if (!item.read_at) void center.markRead([item.id]); close(false); }}
                      >
                        <span className={`notification-entry-icon type-${presentation.icon}`} aria-hidden="true"><OmniIcon name={presentation.icon} size={15} /></span>
                        <span className="notification-entry-text">
                          <span className="notification-entry-message">{item.message}</span>
                          <span className="notification-entry-meta">
                            <span>{presentation.label}</span>
                            {roomName && <><span aria-hidden="true">·</span><span className="truncate">{roomName}</span></>}
                            <span aria-hidden="true">·</span>
                            <time dateTime={item.created_at}>{relativeTime(item.created_at)}</time>
                          </span>
                        </span>
                        {!item.read_at && <span className="notification-entry-dot"><span className="sr-only">Unread</span></span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {center.status === 'error' && center.items.length > 0 && <p role="alert" className="notification-popover-inline-error">{center.error}</p>}
          </div>

          {roomId && (
            <div className="notification-popover-footer notification-popover-room">
              <div className="min-w-0">
                <p className="notification-popover-footer-title">Mute this room</p>
                <p className="notification-popover-hint">{roomMuted ? 'Muted: no mentions, replies or room updates from here.' : 'Stop notifications from this room only.'}</p>
              </div>
              <button type="button" role="switch" aria-checked={roomMuted} onClick={() => void toggleRoomMute()} disabled={roomMuteWorking} className={`notification-switch ${roomMuted ? 'is-on' : ''}`}>
                <span className="sr-only">Mute this room</span>
              </button>
            </div>
          )}

          <div className="notification-popover-footer">
            <div className="min-w-0">
              <p className="notification-popover-footer-title">Do not disturb</p>
              <p className="notification-popover-hint">
                {center.doNotDisturb ? (dndUntil ? `On until ${dndUntil}.` : 'On until you turn it off.') : 'Pause mentions, replies and room updates.'} Access, security and recovery notices always arrive.
              </p>
            </div>
            <div className="notification-popover-dnd">
              {!center.doNotDisturb && (
                <select aria-label="Do not disturb duration" value={dndHours} onChange={(event) => setDndHours(event.target.value)} className="notification-popover-select">
                  <option value="1">1 hour</option>
                  <option value="8">8 hours</option>
                  <option value="24">1 day</option>
                  <option value="off">Until I turn it off</option>
                </select>
              )}
              <button type="button" role="switch" aria-checked={Boolean(center.doNotDisturb)} onClick={() => void toggleDoNotDisturb()} disabled={dndWorking} className={`notification-switch ${center.doNotDisturb ? 'is-on' : ''}`}>
                <span className="sr-only">Do not disturb</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
