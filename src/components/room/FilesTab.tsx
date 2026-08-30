'use client';

import { useState, useEffect, useRef, ChangeEvent } from 'react';
import { createClient } from '@/utils/supabase/client';
import { logTemporaryMedia, getActiveTemporaryMedia } from '@/actions/media';
import { useRoomSync } from '@/hooks/useRoomSync';

interface FilesTabProps {
  roomId: string;
  currentUserRole: string | null;
}

export default function FilesTab({ roomId, currentUserRole }: FilesTabProps) {
  const [mediaList, setMediaList] = useState<any[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();
  const { broadcastEvent } = useRoomSync(roomId);

  const canCast = currentUserRole === 'owner' || currentUserRole === 'admin';

  useEffect(() => {
    loadMedia();
    const interval = setInterval(loadMedia, 60000);
    return () => clearInterval(interval);
  }, [roomId]);

  const loadMedia = async () => {
    const res = await getActiveTemporaryMedia(roomId);
    if (res.success && res.media) setMediaList(res.media);
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) return alert("Files are capped at 50MB.");

    setIsUploading(true);
    try {
      const fileExt = file.name.split('.').pop();
      const uniqueName = `temp-${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
      const filePath = `${roomId}/${uniqueName}`;

      const { error } = await supabase.storage.from('room_attachments').upload(filePath, file, { cacheControl: '3600' });
      if (error) throw error;

      const { data: { publicUrl } } = supabase.storage.from('room_attachments').getPublicUrl(filePath);
      const mediaType = file.type.startsWith('audio') ? 'audio' : 'video';
      await logTemporaryMedia(roomId, file.name, publicUrl, mediaType);
      loadMedia(); 
    } catch (err: any) { alert("Upload failed: " + err.message); } 
    finally { setIsUploading(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  };

  const handleCast = (url: string, title: string) => {
    if (!canCast) return;
    broadcastEvent('cast', { url, title });
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a] border-l border-neutral-800">
      <div className="p-4 border-b border-neutral-800 flex justify-between items-center">
        <h3 className="text-white font-bold text-sm flex items-center gap-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-indigo-400"><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
          Uploaded Media (24h)
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {mediaList.length === 0 ? <p className="text-xs text-neutral-500 text-center mt-10">No temporary media uploaded yet.</p> : (
          mediaList.map((media) => (
            <div key={media.id} className="bg-[#121212] border border-neutral-800 p-3 rounded-xl flex flex-col gap-2 group">
              <div className="flex justify-between items-start">
                <span className="text-white text-xs font-bold truncate pr-2">{media.file_name}</span>
                <span className="text-[9px] text-neutral-500 uppercase font-bold tracking-wider">{media.media_type}</span>
              </div>
              <div className="flex justify-between items-center mt-2">
                <span className="text-[10px] text-neutral-500 flex items-center gap-1">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg>
                  Expires in {Math.round((new Date(media.expires_at).getTime() - Date.now()) / 3600000)}h
                </span>
                {canCast && <button onClick={() => handleCast(media.file_url, media.file_name)} className="px-3 py-1.5 bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 rounded text-[10px] font-bold transition cursor-pointer">Cast to Room</button>}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="p-4 border-t border-neutral-800 bg-[#111]">
        <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" accept="video/*,audio/*" />
        <button onClick={() => fileInputRef.current?.click()} disabled={isUploading} className="w-full py-2.5 bg-neutral-900 border border-neutral-700 hover:border-neutral-600 text-white rounded-lg text-xs font-bold transition disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
          {isUploading ? 'Uploading...' : 'Upload Media (<50MB)'}
        </button>
      </div>
    </div>
  );
}