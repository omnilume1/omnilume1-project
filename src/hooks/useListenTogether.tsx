'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { trackFrom } from '@/hooks/useMusicLibrary';
import { useMusicPlayer, type MusicRemote } from '@/hooks/useMusicPlayer';
import type { MusicTrack } from '@/lib/music-model';
import {
  acceptListenState, canControlListen, listenPositionMs, listenTopic, parseListenSession,
  type ListenAction, type ListenSession, type ListenTarget,
} from '@/lib/music-together';
import { createClient } from '@/utils/supabase/client';

type TrackRow = {
  upload_id: string; owner_name: string; title: string; artist: string; album: string; duration_ms: number | null;
  hue: number; has_cover: boolean; lyrics: string | null; expires_at: string;
};
type ControlArgs = { uploadId?: string | null; positionMs?: number; index?: number; flag?: boolean };

type ListenTogether = {
  target: ListenTarget | null;
  session: ListenSession | null;
  tracks: MusicTrack[];
  tracksById: Map<string, MusicTrack>;
  userId: string | null;
  /** True while the local player follows the shared session. */
  following: boolean;
  canControl: boolean;
  error: string | null;
  select: (target: ListenTarget | null) => Promise<void>;
  join: (hostOnly: boolean) => Promise<void>;
  leave: () => void;
  control: (action: ListenAction, args?: ControlArgs) => Promise<void>;
  reloadTracks: () => Promise<void>;
};

const ListenTogetherContext = createContext<ListenTogether | null>(null);

export function ListenTogetherProvider({ children }: { children: ReactNode }) {
  const { applyRemote, setRemote } = useMusicPlayer();
  const [target, setTarget] = useState<ListenTarget | null>(null);
  const [session, setSession] = useState<ListenSession | null>(null);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetRef = useRef<ListenTarget | null>(null);
  const missingRef = useRef<string | null>(null);
  const sessionRef = useRef<ListenSession | null>(null);
  const followingRef = useRef(false);

  const leave = useCallback(() => {
    setRemote(null);
    followingRef.current = false;
    setFollowing(false);
  }, [setRemote]);

  const receive = useCallback((raw: unknown) => {
    const incoming = parseListenSession(raw, Date.now());
    const current = targetRef.current;
    if (!incoming || !current || incoming.targetKind !== current.kind || incoming.targetId !== current.id) return;
    const next = acceptListenState(sessionRef.current, incoming);
    if (next === sessionRef.current) return;
    sessionRef.current = next;
    setSession(next);
    if (next?.ended && followingRef.current) {
      leave();
      applyRemote({ track: null, positionMs: 0, playing: false });
      setError('The session has ended.');
    }
  }, [leave, applyRemote]);

  const loadTracks = useCallback(async (forTarget: ListenTarget) => {
    const { data, error: tracksError } = await createClient().rpc('list_music_listen_tracks', { p_kind: forTarget.kind, p_target: forTarget.id });
    if (tracksError || targetRef.current !== forTarget) return;
    setTracks((data as TrackRow[]).map((row) => trackFrom(
      { ...row, id: row.upload_id },
      { available: true, hasCover: row.has_cover, sharedFrom: row.owner_name },
    )));
  }, []);

  const fetchSession = useCallback(async (forTarget: ListenTarget) => {
    const { data, error: sessionError } = await createClient().rpc('get_music_listen_session', { p_kind: forTarget.kind, p_target: forTarget.id });
    if (sessionError) setError(sessionError.message || 'Could not load the session.');
    else if (data) receive(data);
  }, [receive]);

  const control = useCallback(async (action: ListenAction, args: ControlArgs = {}) => {
    const current = targetRef.current;
    if (!current) return;
    const { data, error: controlError } = await createClient().rpc('music_listen_control', {
      p_kind: current.kind, p_target: current.id, p_action: action,
      p_upload_id: args.uploadId ?? null, p_position_ms: args.positionMs ?? null, p_index: args.index ?? null, p_flag: args.flag ?? null,
    });
    if (controlError) {
      setError(controlError.message || 'That didn’t work. Try again.');
      if (controlError.code === '55000') void fetchSession(current); // queue changed underneath us
      return;
    }
    setError(null);
    receive(data);
  }, [receive, fetchSession]);

  const select = useCallback(async (next: ListenTarget | null) => {
    if (targetRef.current && next && targetRef.current.kind === next.kind && targetRef.current.id === next.id) return;
    leave();
    targetRef.current = next;
    missingRef.current = null;
    sessionRef.current = null;
    setTarget(next);
    setSession(null);
    setTracks([]);
    setError(null);
    if (!next) return;
    const { data: { user } } = await createClient().auth.getUser();
    setUserId(user?.id ?? null);
    await Promise.all([fetchSession(next), loadTracks(next)]);
  }, [leave, fetchSession, loadTracks]);

  // Private topic: members receive server-sent state only (no client publishing exists).
  useEffect(() => {
    if (!target) return;
    const supabase = createClient();
    const channel = supabase
      .channel(listenTopic(target.kind, target.id), { config: { private: true } })
      .on('broadcast', { event: 'state' }, ({ payload }: { payload: unknown }) => receive(payload))
      // Catch up on anything sent before the subscription was live.
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') void fetchSession(target);
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [target, receive, fetchSession]);

  const tracksById = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);

  const join = useCallback(async (hostOnly: boolean) => {
    const current = targetRef.current;
    if (!current) return;
    const remote: MusicRemote = {
      play: (positionMs) => void control('play', { positionMs }),
      pause: (positionMs) => void control('pause', { positionMs }),
      seek: (positionMs) => void control('seek', { positionMs }),
      next: (fromUploadId) => void control('next', { uploadId: fromUploadId }),
      load: (track) => void (track.uploadId ? control('load', { uploadId: track.uploadId }) : setError('Only uploads can be played together.')),
      enqueue: (track) => void (track.uploadId ? control('enqueue', { uploadId: track.uploadId }) : setError('Only uploads can be played together.')),
      leave,
    };
    await control('start', { flag: hostOnly });
    // Follow only a live session of the target still selected (a failed start leaves the error shown).
    if (targetRef.current !== current || !sessionRef.current || sessionRef.current.ended) return;
    setRemote(remote);
    followingRef.current = true;
    setFollowing(true);
  }, [control, leave, setRemote]);

  // Follow the shared playhead: on every new state, and every 3 s while playing to correct drift.
  useEffect(() => {
    if (!following || !session) return;
    if (session.ended) return; // receive() already stopped following
    const track = session.uploadId ? tracksById.get(session.uploadId) ?? null : null;
    if (session.uploadId && !track && missingRef.current !== session.uploadId && targetRef.current) {
      // Shared after we loaded the list: fetch once, then this effect runs again.
      missingRef.current = session.uploadId;
      void loadTracks(targetRef.current);
      return;
    }
    const apply = () => applyRemote({
      track,
      positionMs: listenPositionMs(session, Date.now(), track?.durationMs),
      playing: session.isPlaying && Boolean(track),
    });
    apply();
    if (!session.isPlaying) return;
    const timer = window.setInterval(apply, 3_000);
    return () => window.clearInterval(timer);
  }, [following, session, tracksById, applyRemote, leave, loadTracks]);

  const reloadTracks = useCallback(async () => {
    if (targetRef.current) await loadTracks(targetRef.current);
  }, [loadTracks]);

  const value = useMemo<ListenTogether>(() => ({
    target, session, tracks, tracksById, userId, following, canControl: canControlListen(session, userId), error,
    select, join, leave, control, reloadTracks,
  }), [target, session, tracks, tracksById, userId, following, error, select, join, leave, control, reloadTracks]);

  return <ListenTogetherContext.Provider value={value}>{children}</ListenTogetherContext.Provider>;
}

export function useListenTogether() {
  const together = useContext(ListenTogetherContext);
  if (!together) throw new Error('useListenTogether must be used inside ListenTogetherProvider');
  return together;
}
