'use client';

import { useEffect, useRef, useState, FormEvent, ChangeEvent } from 'react';
import dynamic from 'next/dynamic';
import { useRoomSync } from '@/hooks/useRoomSync';
import { createClient } from '@/utils/supabase/client';

const Player = dynamic(() => import('react-player'), { ssr: false }) as any;

interface MediaStageProps {
  roomId: string;
  currentUserRole: string | null;
}

export default function MediaStage({ roomId, currentUserRole }: MediaStageProps) {
  const { mediaState, activeMediaUrl, activeSubtitleUrl, broadcastEvent, syncRequestTrigger } = useRoomSync(roomId);
  
  const playerRef = useRef<any>(null); 
  const subtitleFileRef = useRef<HTMLInputElement>(null);
  const isSyncing = useRef(false);
  
  const [playing, setPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [castInput, setCastInput] = useState("");
  const [isUploadingSub, setIsUploadingSub] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [isReady, setIsReady] = useState(false);

  // PHASE 25: Personal Audio & Subtitle Settings
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'subtitles' | 'audio'>('subtitles');
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [subSize, setSubSize] = useState('100%');
  const [subColor, setSubColor] = useState('#ffffff');
  const [subBg, setSubBg] = useState('rgba(0, 0, 0, 0.75)');
  
  const [audioTracks, setAudioTracks] = useState<any[]>([]);
  const [activeAudioIndex, setActiveAudioIndex] = useState(0);

  const supabase = createClient();
  const canCast = currentUserRole === 'owner' || currentUserRole === 'admin';
  const mediaTitle = mediaState?.payload?.title || "External Stream";

  useEffect(() => {
    setMounted(true);
    const handleUnhandledRejection = (e: PromiseRejectionEvent) => { if (e.reason?.name === 'AbortError') e.preventDefault(); };
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => window.removeEventListener('unhandledrejection', handleUnhandledRejection);
  }, []);

  const safeGetTime = () => playerRef.current?.getCurrentTime ? playerRef.current.getCurrentTime() : 0;
  const safeSeekTo = (time: number) => { if (playerRef.current?.seekTo) playerRef.current.seekTo(time, 'seconds'); };

  useEffect(() => {
    if (!mediaState || !mounted || !isReady) return;
    isSyncing.current = true;

    const targetTime = mediaState.payload.time || 0;
    const targetSpeed = mediaState.payload.speed || 1.0;

    if (playbackSpeed !== targetSpeed) setPlaybackSpeed(targetSpeed);

    if (mediaState.type === 'play') {
      setPlaying(true);
      if (Math.abs(safeGetTime() - targetTime) > 2) safeSeekTo(targetTime);
    } else if (mediaState.type === 'pause') {
      setPlaying(false);
      safeSeekTo(targetTime);
    } else if (mediaState.type === 'seek') {
      safeSeekTo(targetTime);
    }

    setTimeout(() => { isSyncing.current = false; }, 1000);
  }, [mediaState, mounted, isReady]);

  useEffect(() => { if (mounted && !canCast) broadcastEvent('request_sync'); }, [mounted, canCast, broadcastEvent]);
  useEffect(() => { if (syncRequestTrigger > 0 && canCast && activeMediaUrl) forceSyncToRoom(); }, [syncRequestTrigger, canCast, activeMediaUrl]);

  const forceSyncToRoom = () => {
    if (!canCast || !activeMediaUrl) return;
    broadcastEvent('force_sync', { url: activeMediaUrl, subtitleUrl: activeSubtitleUrl, title: mediaTitle, time: safeGetTime(), speed: playbackSpeed, playing });
  };

  const handlePlay = () => { if (!isSyncing.current) { setPlaying(true); broadcastEvent('play', { time: safeGetTime(), speed: playbackSpeed, title: mediaTitle }); } };
  const handlePause = () => { if (!isSyncing.current) { setPlaying(false); broadcastEvent('pause', { time: safeGetTime(), speed: playbackSpeed, title: mediaTitle }); } };
  
  const handleReady = () => { 
    setIsReady(true); 
    if (mediaState?.payload?.time) safeSeekTo(mediaState.payload.time); 
    
    // Attempt to extract native audio tracks if the browser/format supports it
    const internalPlayer = playerRef.current?.getInternalPlayer();
    if (internalPlayer && internalPlayer.audioTracks) {
      const tracks = [];
      for (let i = 0; i < internalPlayer.audioTracks.length; i++) {
        tracks.push({ id: i, label: internalPlayer.audioTracks[i].language || `Audio Track ${i + 1}` });
      }
      setAudioTracks(tracks);
    }
  };

  const changeAudioTrack = (index: number) => {
    const internalPlayer = playerRef.current?.getInternalPlayer();
    if (internalPlayer && internalPlayer.audioTracks) {
      for (let i = 0; i < internalPlayer.audioTracks.length; i++) {
        internalPlayer.audioTracks[i].enabled = (i === index);
      }
      setActiveAudioIndex(index);
    }
  };

  const changePlaybackSpeed = (speed: number) => {
    if (!canCast) return;
    setPlaybackSpeed(speed);
    broadcastEvent('play', { time: safeGetTime(), speed, title: mediaTitle });
  };

  const startUrlCasting = async (e: FormEvent) => {
    e.preventDefault();
    if (!castInput.trim() || !canCast) return;
    
    let finalUrl = castInput.trim();
    const ytMatch = finalUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|live\/|shorts\/))([\w-]{11})/);
    if (ytMatch && ytMatch[1]) finalUrl = `https://www.youtube.com/watch?v=${ytMatch[1]}`;
    else if (!/^https?:\/\//i.test(finalUrl)) finalUrl = 'https://' + finalUrl;

    setIsReady(false); 
    broadcastEvent('cast', { url: finalUrl, title: "YouTube / Web Stream", speed: 1.0 });
    setCastInput("");
    setPlaying(true);
  };

  const startSubtitleUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !canCast) return;
    
    setIsUploadingSub(true);
    try {
      const fileExt = file.name.split('.').pop();
      const uniqueName = `sub-${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
      const filePath = `${roomId}/${uniqueName}`;

      const { error } = await supabase.storage.from('room_attachments').upload(filePath, file, { cacheControl: '3600' });
      if (error) throw error;

      const { data: { publicUrl } } = supabase.storage.from('room_attachments').getPublicUrl(filePath);
      broadcastEvent('subtitle_upload', { subtitleUrl: publicUrl });
    } catch (err: any) { alert("Subtitle upload failed: " + err.message); } 
    finally { setIsUploadingSub(false); if (subtitleFileRef.current) subtitleFileRef.current.value = ''; }
  };

  const stopCasting = async () => {
    if (!canCast) return;
    setPlaying(false);
    setTimeout(() => { broadcastEvent('stop_cast'); setIsReady(false); }, 100);
  };

  if (!mounted) return null;

  return (
    <section className="relative flex min-h-0 flex-1 flex-col p-3 sm:p-4">
      {/* Dynamic Native CSS Injection for Personal Subtitles */}
      <style dangerouslySetInnerHTML={{__html: `
        video::cue {
          font-size: ${subSize} !important;
          color: ${subColor} !important;
          background-color: ${subBg} !important;
          font-family: sans-serif;
          font-weight: bold;
          text-shadow: 1px 1px 2px black;
        }
      `}} />

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#0b0b0b] shadow-2xl">
        <div className="absolute top-0 inset-x-0 p-4 bg-gradient-to-b from-black/90 to-transparent z-10 flex justify-between items-center pointer-events-auto">
          <div className="flex flex-col">
            <span className="text-white font-bold text-sm drop-shadow-md">{activeMediaUrl ? mediaTitle : 'Watch Party Stage'}</span>
            {activeMediaUrl && <span className="text-indigo-400 text-[10px] font-bold uppercase tracking-widest">{playbackSpeed}x Speed</span>}
          </div>
          <div className="flex items-center gap-3">
            {activeMediaUrl && canCast && (
              <div className="hidden md:flex bg-neutral-900/80 backdrop-blur-md rounded border border-neutral-700 overflow-hidden">
                {[0.5, 1.0, 1.5, 2.0].map(speed => (
                  <button key={speed} onClick={() => changePlaybackSpeed(speed)} className={`px-2 py-1 text-[10px] font-bold cursor-pointer transition ${playbackSpeed === speed ? 'bg-indigo-600 text-white' : 'text-neutral-400 hover:bg-neutral-800'}`}>{speed}x</button>
                ))}
              </div>
            )}
            
            {/* VLC-Style Settings Gear */}
            {activeMediaUrl && (
              <div className="relative">
                <button onClick={() => setShowSettings(!showSettings)} className="p-1.5 bg-neutral-800/80 hover:bg-neutral-700 border border-neutral-600 rounded-md text-white transition cursor-pointer backdrop-blur-md">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"></path></svg>
                </button>

                {showSettings && (
                  <div className="absolute top-full right-0 mt-2 w-64 bg-[#121212] border border-neutral-700 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 z-50">
                    <div className="flex border-b border-neutral-800">
                      <button onClick={() => setSettingsTab('subtitles')} className={`flex-1 py-2 text-xs font-bold uppercase cursor-pointer ${settingsTab === 'subtitles' ? 'bg-indigo-600/20 text-indigo-400' : 'text-neutral-500 hover:text-white'}`}>Subtitles</button>
                      <button onClick={() => setSettingsTab('audio')} className={`flex-1 py-2 text-xs font-bold uppercase cursor-pointer ${settingsTab === 'audio' ? 'bg-indigo-600/20 text-indigo-400' : 'text-neutral-500 hover:text-white'}`}>Audio</button>
                    </div>
                    
                    <div className="p-4 max-h-[300px] overflow-y-auto">
                      {settingsTab === 'subtitles' ? (
                        <div className="flex flex-col gap-4">
                          <div className="flex justify-between items-center">
                            <span className="text-xs font-bold text-white">Visibility</span>
                            <button onClick={() => setShowSubtitles(!showSubtitles)} className={`px-3 py-1 rounded text-[10px] font-bold uppercase transition cursor-pointer ${showSubtitles ? 'bg-emerald-500/20 text-emerald-400' : 'bg-neutral-800 text-neutral-400'}`}>{showSubtitles ? 'ON' : 'OFF'}</button>
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <span className="text-[10px] uppercase font-bold text-neutral-500">Size</span>
                            <select value={subSize} onChange={(e) => setSubSize(e.target.value)} className="w-full bg-[#1a1a1a] border border-neutral-800 rounded p-1.5 text-xs text-white outline-none cursor-pointer">
                              <option value="75%">Small</option>
                              <option value="100%">Normal</option>
                              <option value="150%">Large</option>
                              <option value="200%">Extra Large</option>
                            </select>
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <span className="text-[10px] uppercase font-bold text-neutral-500">Color</span>
                            <select value={subColor} onChange={(e) => setSubColor(e.target.value)} className="w-full bg-[#1a1a1a] border border-neutral-800 rounded p-1.5 text-xs text-white outline-none cursor-pointer">
                              <option value="#ffffff">White</option>
                              <option value="#ffff00">Yellow</option>
                              <option value="#00ffff">Cyan</option>
                            </select>
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <span className="text-[10px] uppercase font-bold text-neutral-500">Background</span>
                            <select value={subBg} onChange={(e) => setSubBg(e.target.value)} className="w-full bg-[#1a1a1a] border border-neutral-800 rounded p-1.5 text-xs text-white outline-none cursor-pointer">
                              <option value="transparent">None</option>
                              <option value="rgba(0, 0, 0, 0.75)">Dark (Standard)</option>
                              <option value="rgba(0, 0, 0, 1)">Solid Black</option>
                            </select>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-2">
                          <span className="text-xs font-bold text-white mb-2">Available Tracks</span>
                          {audioTracks.length === 0 ? (
                            <p className="text-[10px] text-neutral-500 leading-relaxed">
                              Only 1 default audio track detected. Multiple audio tracks require a browser that supports native track switching, or an advanced backend media transcoder.
                            </p>
                          ) : (
                            audioTracks.map((track, idx) => (
                              <button 
                                key={idx} 
                                onClick={() => changeAudioTrack(track.id)}
                                className={`w-full text-left px-3 py-2 rounded text-xs font-bold transition cursor-pointer ${activeAudioIndex === track.id ? 'bg-indigo-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
                              >
                                {track.label}
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeMediaUrl && canCast && <button onClick={stopCasting} className="px-3 py-1 bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30 rounded text-xs font-bold transition backdrop-blur-md cursor-pointer">Stop</button>}
            {activeMediaUrl && <button onClick={canCast ? forceSyncToRoom : () => broadcastEvent('request_sync')} className="px-2 py-1 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 rounded text-[10px] text-emerald-400 font-bold uppercase tracking-wider backdrop-blur-md transition cursor-pointer shadow-lg">{canCast ? 'Force Sync' : 'Sync to Host'}</button>}
          </div>
        </div>

        <div className="relative flex flex-1 flex-col items-center justify-center bg-black p-4">
          {activeMediaUrl ? (
            <div className="w-full h-full relative border border-neutral-800 rounded-xl overflow-hidden">
              <Player 
                ref={playerRef} 
                url={activeMediaUrl} 
                playing={playing} 
                playbackRate={playbackSpeed} 
                controls={true} 
                width="100%" 
                height="100%" 
                onReady={handleReady} 
                onPlay={handlePlay} 
                onPause={handlePause} 
                config={{ 
                  youtube: { playerVars: { modestbranding: 1, rel: 0, iv_load_policy: 3 } }, 
                  file: { 
                    attributes: { crossOrigin: 'anonymous' }, 
                    tracks: activeSubtitleUrl && showSubtitles ? [{ kind: 'subtitles', src: activeSubtitleUrl, srcLang: 'en', default: true, label: 'English' }] : [] 
                  } 
                }} 
              />
              {canCast && !activeSubtitleUrl && !activeMediaUrl.includes('youtube.com') && (
                <div className="absolute bottom-16 right-4 z-20">
                   <input type="file" ref={subtitleFileRef} onChange={startSubtitleUpload} className="hidden" accept=".vtt,.srt" />
                   <button onClick={() => subtitleFileRef.current?.click()} disabled={isUploadingSub} className="px-4 py-2 bg-indigo-600/80 hover:bg-indigo-600 text-white backdrop-blur-md text-xs font-bold rounded-lg shadow-2xl transition cursor-pointer border border-indigo-500/50">{isUploadingSub ? 'Uploading...' : '+ Add .SRT / .VTT'}</button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center max-w-md w-full">
              <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-white/5"><svg viewBox="0 0 24 24" className="ml-0.5 h-7 w-7 text-white" fill="currentColor"><path d="M8 5.14v13.72L19.06 12 8 5.14z" /></svg></div>
              <h2 className="text-lg font-bold text-white mb-2">Stage is empty</h2>
              {canCast ? (
                <div className="w-full mt-4 flex flex-col gap-4">
                  <p className="text-xs text-neutral-400 text-center">Cast a video via URL below, or upload a 24-hour file from the "Uploaded Media" folder in the sidebar.</p>
                  <form onSubmit={startUrlCasting} className="flex gap-2 mt-2">
                    <input type="text" value={castInput} onChange={(e) => setCastInput(e.target.value)} placeholder="Paste YouTube, MP4, or media URL..." className="flex-1 bg-[#121212] border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 transition" />
                    <button type="submit" className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-lg transition cursor-pointer">Cast</button>
                  </form>
                </div>
              ) : <p className="mt-2 text-sm text-zinc-500">Waiting for a room admin to cast media...</p>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}