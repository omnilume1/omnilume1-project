'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createRoom } from '@/actions/rooms';

export default function CreateRoomPage() {
  const [loading, setLoading] = useState(false);
  const [isTemp, setIsTemp] = useState(false);
  const [allowRecovery, setAllowRecovery] = useState(true);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);

    try {
      const formData = new FormData(e.currentTarget);
      
      // Translate the friendly UI into strict database policies
      const policy = isTemp ? (allowRecovery ? 'recoverable' : 'irreversible') : 'permanent';
      formData.append('expiration_type', policy);

      const roomId = await createRoom(formData);
      router.push(`/room/${roomId}`);
    } catch (error: any) {
      alert(error.message || "Failed to create room.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-[#0a0a0a] border border-neutral-800 rounded-xl p-8 max-h-[90vh] overflow-y-auto custom-scrollbar">
        <h1 className="text-xl font-semibold mb-6">Create a New Room</h1>
        
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-2">Room Name *</label>
            <input name="name" type="text" required placeholder="e.g., Late Night Study" className="w-full bg-[#050505] border border-neutral-800 rounded-md px-4 py-2.5 text-sm focus:border-neutral-500 outline-none" />
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-2">Custom Link (Optional)</label>
            <div className="flex border border-neutral-800 rounded-md bg-[#050505] overflow-hidden focus-within:border-neutral-500 transition">
              <span className="bg-neutral-900 px-3 py-2.5 text-sm text-neutral-500 border-r border-neutral-800">omnilume.com/r/</span>
              <input name="username" type="text" placeholder="my_custom_room" className="w-full bg-transparent px-3 py-2.5 text-sm text-white outline-none" />
            </div>
          </div>

          {/* Crisp Expiration UI */}
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-2">Room Lifespan</label>
            <div className="flex gap-2 mb-3">
              <button type="button" onClick={() => setIsTemp(false)} className={`flex-1 py-2 rounded-md text-xs font-semibold transition ${!isTemp ? 'bg-neutral-200 text-black' : 'bg-neutral-900 text-neutral-400 border border-neutral-800'}`}>Permanent</button>
              <button type="button" onClick={() => setIsTemp(true)} className={`flex-1 py-2 rounded-md text-xs font-semibold transition ${isTemp ? 'bg-neutral-200 text-black' : 'bg-neutral-900 text-neutral-400 border border-neutral-800'}`}>Temporary</button>
            </div>

            {isTemp && (
              <div className="bg-neutral-900/50 p-4 rounded-lg border border-neutral-800 flex flex-col gap-3 animate-in fade-in slide-in-from-top-2 duration-200">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-amber-500 mb-2">Self-Destruct Timer (Hours)</label>
                  <input name="expires_in_hours" type="number" min="1" max="720" required defaultValue="24" className="w-full bg-[#050505] border border-amber-900/30 rounded-md px-4 py-2.5 text-sm focus:border-amber-500 outline-none" />
                </div>
                <div className="flex items-start gap-3 mt-1">
                  <input type="checkbox" checked={allowRecovery} onChange={(e) => setAllowRecovery(e.target.checked)} className="w-4 h-4 mt-0.5 accent-amber-500 cursor-pointer" />
                  <label onClick={() => setAllowRecovery(!allowRecovery)} className="text-xs text-neutral-300 cursor-pointer leading-relaxed">
                    <strong>Enable Quarantine:</strong> If unchecked, all files and chats are permanently burned when the timer ends.
                  </label>
                </div>
              </div>
            )}
          </div>

          <div className="w-full h-px bg-neutral-800 my-1" />

          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <input type="checkbox" name="is_private" value="true" id="private-toggle" className="w-4 h-4 accent-neutral-500 cursor-pointer" />
              <label htmlFor="private-toggle" className="text-sm text-neutral-300 cursor-pointer"><strong>Private Space</strong> (Requires approval)</label>
            </div>
            <div className="flex items-center gap-3">
              <input type="checkbox" name="is_anonymous" value="true" id="anon-toggle" className="w-4 h-4 accent-indigo-500 cursor-pointer" />
              <label htmlFor="anon-toggle" className="text-sm text-neutral-300 cursor-pointer"><strong>Ghost Mode</strong> (Hide user identities)</label>
            </div>
          </div>

          <button type="submit" disabled={loading} className="w-full mt-4 py-3 bg-white text-black font-semibold rounded-md text-sm hover:bg-neutral-200 transition disabled:opacity-50">
            {loading ? 'Creating...' : 'Launch Room'}
          </button>
        </form>
      </div>
    </div>
  );
}