'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/utils/supabase/client';

export type SyncEvent = {
  event_id: string;
  sender_id: string;
  timestamp: number;
  room_id: string;
  event_type: 'typing' | 'play' | 'pause' | 'seek' | 'cast' | 'stop_cast' | 'force_sync' | 'request_sync' | 'timer_start' | 'timer_pause' | 'timer_reset' | 'subtitle_upload';
  payload: any;
  state_version: number;
};

export function useRoomSync(roomId: string) {
  const supabase = createClient();
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [channel, setChannel] = useState<any>(null);
  
  const [typingUsers, setTypingUsers] = useState<Map<string, number>>(new Map());
  const [mediaState, setMediaState] = useState<{ type: string, payload: any } | null>(null);
  const [activeMediaUrl, setActiveMediaUrl] = useState<string | null>(null);
  const [activeSubtitleUrl, setActiveSubtitleUrl] = useState<string | null>(null);
  const [syncRequestTrigger, setSyncRequestTrigger] = useState(0);

  const [timerState, setTimerState] = useState<{ isRunning: boolean, endTime: number | null, remaining: number, duration: number }>(() => {
    if (typeof window !== 'undefined') {
      const saved = sessionStorage.getItem(`timer:${roomId}`);
      if (saved) return JSON.parse(saved);
    }
    return { isRunning: false, endTime: null, remaining: 25 * 60, duration: 25 * 60 };
  });

  const updateTimerState = (newState: any) => {
    setTimerState(newState);
    if (typeof window !== 'undefined') sessionStorage.setItem(`timer:${roomId}`, JSON.stringify(newState));
  };

  useEffect(() => {
    let isMounted = true;
    let syncChannel: ReturnType<typeof supabase.channel>;

    async function setup() {
      const { data: { user } } = await supabase.auth.getUser();
      if (user && isMounted) setCurrentUserId(user.id);

      syncChannel = supabase.channel(`sync:${roomId}`);

      syncChannel
        .on('broadcast', { event: 'room_action' }, ({ payload }: { payload: SyncEvent }) => {
          if (!isMounted) return;

          if (payload.event_type === 'typing') setTypingUsers(prev => { const m = new Map(prev); m.set(payload.sender_id, Date.now()); return m; });
          
          if (payload.event_type === 'cast') { setActiveMediaUrl(payload.payload.url); setActiveSubtitleUrl(null); }
          if (payload.event_type === 'subtitle_upload') setActiveSubtitleUrl(payload.payload.subtitleUrl);
          if (payload.event_type === 'stop_cast') { setActiveMediaUrl(null); setActiveSubtitleUrl(null); setMediaState(null); }
          if (payload.event_type === 'request_sync') setSyncRequestTrigger(Date.now());

          if (payload.event_type === 'force_sync') {
            if (payload.payload?.url) setActiveMediaUrl(payload.payload.url);
            if (payload.payload?.subtitleUrl) setActiveSubtitleUrl(payload.payload.subtitleUrl);
            setMediaState({ type: payload.payload?.playing ? 'play' : 'pause', payload: { time: payload.payload?.time, speed: payload.payload?.speed, title: payload.payload?.title } });
          }

          if (['play', 'pause', 'seek'].includes(payload.event_type)) {
            setMediaState({ type: payload.event_type, payload: payload.payload });
            if (payload.payload?.url && !activeMediaUrl) setActiveMediaUrl(payload.payload.url);
          }

          if (payload.event_type === 'timer_start') updateTimerState({ isRunning: true, endTime: payload.payload.endTime, remaining: payload.payload.remaining, duration: payload.payload.duration });
          if (payload.event_type === 'timer_pause') updateTimerState({ isRunning: false, endTime: null, remaining: payload.payload.remaining, duration: payload.payload.duration });
          if (payload.event_type === 'timer_reset') updateTimerState({ isRunning: false, endTime: null, remaining: payload.payload.duration, duration: payload.payload.duration });
        })
        .subscribe();

      if (isMounted) setChannel(syncChannel);
    }
    setup();

    const typingInterval = setInterval(() => {
      setTypingUsers(prev => {
        const m = new Map(prev);
        let changed = false;
        m.forEach((ts, id) => { if (Date.now() - ts > 3000) { m.delete(id); changed = true; } });
        return changed ? m : prev;
      });
    }, 1000);

    return () => { isMounted = false; clearInterval(typingInterval); if (syncChannel) { syncChannel.unsubscribe(); supabase.removeChannel(syncChannel); } };
  }, [roomId, supabase, activeMediaUrl]);

  const broadcastEvent = useCallback((eventType: SyncEvent['event_type'], payload: any = {}) => {
    if (!channel || !currentUserId || channel.state !== 'joined') return;

    if (eventType === 'cast') { setActiveMediaUrl(payload.url); setActiveSubtitleUrl(null); }
    if (eventType === 'subtitle_upload') setActiveSubtitleUrl(payload.subtitleUrl);
    if (eventType === 'stop_cast') { setActiveMediaUrl(null); setActiveSubtitleUrl(null); setMediaState(null); }
    if (['play', 'pause', 'seek'].includes(eventType)) setMediaState({ type: eventType, payload });

    if (eventType === 'timer_start') updateTimerState({ isRunning: true, endTime: payload.endTime, remaining: payload.remaining, duration: payload.duration });
    if (eventType === 'timer_pause') updateTimerState({ isRunning: false, endTime: null, remaining: payload.remaining, duration: payload.duration });
    if (eventType === 'timer_reset') updateTimerState({ isRunning: false, endTime: null, remaining: payload.duration, duration: payload.duration });

    channel.send({ type: 'broadcast', event: 'room_action', payload: { event_id: crypto.randomUUID(), sender_id: currentUserId, timestamp: Date.now(), room_id: roomId, event_type: eventType, payload, state_version: 1 } });
  }, [channel, currentUserId, roomId]);

  return { typingUsers, mediaState, activeMediaUrl, activeSubtitleUrl, timerState, syncRequestTrigger, broadcastEvent };
}