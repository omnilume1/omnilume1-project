'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createRoom } from '@/actions/rooms';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import { OmniIcon } from '@/components/ui/OmniIcon';
import FlippingWords from '@/components/ui/FlippingWords';

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
      const policy = isTemp ? (allowRecovery ? 'recoverable' : 'irreversible') : 'permanent';
      formData.append('expiration_type', policy);
      const roomId = await createRoom(formData);
      router.push(`/room/${roomId}`);
    } catch (error: unknown) {
      alert(error instanceof Error ? error.message : "Failed to create room.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="omni-internal">
      <InternalTopbar eyebrow="Make space for momentum" title="Create a room" description="Set up a focused space for watching, studying and connecting." actions={<Link href="/explore" className="omni-button omni-button-ghost">Back to explore</Link>} />
      <main className="omni-main-content">
        <form onSubmit={handleSubmit} className="glass-panel omni-form-card fade-up">
          <p className="section-kicker">New shared space</p>
          <h2>Bring people together.</h2>
          <p className="section-copy mb-8">Choose a name, set the room rules and invite people when you are ready.</p>
          <FlippingWords
            prefix="CREATE A ROOM ·"
            phrases={["WATCH TOGETHER", "LISTEN TOGETHER", "STUDY TOGETHER", "WORK TOGETHER", "CREATE TOGETHER"]}
            className="create-room-flipping-words"
          />

          <div className="grid gap-5">
            <div><label className="form-label" htmlFor="room-name">Room name <span className="text-cyan-200">*</span></label><input id="room-name" name="name" type="text" required placeholder="e.g. Late Night Study" className="omni-input" /></div>
            <div><label className="form-label" htmlFor="room-username">Custom link <span className="text-neutral-500">(optional)</span></label><div className="flex overflow-hidden rounded-xl border border-white/10 bg-black/20 focus-within:border-cyan-200/50"><span className="flex items-center border-r border-white/10 px-3 text-xs text-neutral-500">omnilume.com/r/</span><input id="room-username" name="username" type="text" placeholder="my_custom_room" className="min-w-0 flex-1 bg-transparent px-3 py-3 text-sm text-white outline-none" /></div><p className="form-help">A memorable link people can use to find your room.</p></div>

            <div><p className="form-label">Room lifespan</p><div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => setIsTemp(false)} className={`omni-button ${!isTemp ? 'omni-button-primary' : 'omni-button-ghost'}`}>Permanent</button><button type="button" onClick={() => setIsTemp(true)} className={`omni-button ${isTemp ? 'omni-button-primary' : 'omni-button-ghost'}`}>Temporary</button></div></div>

            {isTemp && <div className="rounded-2xl border border-amber-300/20 bg-amber-200/[0.04] p-4"><div><label className="form-label text-amber-100" htmlFor="expires-hours">Self-destruct timer (hours)</label><input id="expires-hours" name="expires_in_hours" type="number" min="1" max="720" required defaultValue="24" className="omni-input border-amber-300/20" /></div><label className="mt-4 flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-neutral-300"><input type="checkbox" checked={allowRecovery} onChange={(e) => setAllowRecovery(e.target.checked)} className="mt-0.5 h-4 w-4 accent-amber-400" /><span><strong className="text-amber-100">Enable quarantine:</strong> If unchecked, files and chats are permanently burned when the timer ends.</span></label></div>}

            <div className="h-px bg-white/10" />
            <div className="grid gap-3"><label className="flex cursor-pointer items-center gap-3 text-sm text-neutral-300"><input type="checkbox" name="is_private" value="true" id="private-toggle" className="h-4 w-4 accent-neutral-300" /><span><strong className="text-white">Private space</strong> <span className="text-neutral-500">(requires approval)</span></span></label><label className="flex cursor-pointer items-center gap-3 text-sm text-neutral-300"><input type="checkbox" name="is_anonymous" value="true" id="anon-toggle" className="h-4 w-4 accent-cyan-300" /><span><strong className="text-white">Ghost mode</strong> <span className="text-neutral-500">(hide user identities)</span></span></label></div>

            <button type="submit" disabled={loading} className="omni-button omni-button-primary mt-3 w-full">{loading ? 'Creating room...' : 'Launch room'} <OmniIcon name="arrow" size={15} /></button>
          </div>
        </form>
      </main>
      <FloatingDock />
    </div>
  );
}
