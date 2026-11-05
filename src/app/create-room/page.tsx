'use client';

import { unwrapAction } from '@/lib/action-result';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listRoomTemplates, type RoomTemplate } from '@/lib/management-data';
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
  const [isScheduled, setIsScheduled] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [hours, setHours] = useState(24);
  const [templates, setTemplates] = useState<RoomTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const router = useRouter();

  useEffect(() => {
    let active = true;
    void listRoomTemplates().then((result) => { if (active && result.ok) setTemplates(result.data); });
    return () => { active = false; };
  }, []);

  // A template only pre-fills this form; privacy and lifespan stay the
  // creator's choice, and the controls are applied by the server after the
  // room exists (apply_room_template, owner only).
  const chooseTemplate = (id: string) => {
    setTemplateId(id);
    const config = templates.find((template) => template.id === id)?.config;
    if (!config) return;
    setIsPrivate(config.is_private);
    setIsTemp(config.expiration_type !== 'permanent');
    setAllowRecovery(config.expiration_type === 'recoverable');
    if (config.duration_hours) setHours(Math.min(720, Math.max(1, config.duration_hours)));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    try {
      const formData = new FormData(e.currentTarget);
      const policy = isTemp ? (allowRecovery ? 'recoverable' : 'irreversible') : 'permanent';
      formData.append('expiration_type', policy);
      if (templateId) formData.append('template_id', templateId);
      const roomId = await createRoom(formData).then(unwrapAction);
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
            phrases={["GROW TOGETHER", "STUDY TOGETHER", "WATCH TOGETHER"]}
            className="create-room-flipping-words"
          />

          <div className="grid gap-5">
            <div><label className="form-label" htmlFor="room-name">Room name <span className="text-violet-300">*</span></label><input id="room-name" name="name" type="text" required placeholder="e.g. Late Night Study" className="omni-input" /></div>
            <div><label className="form-label" htmlFor="room-username">Custom link <span className="text-neutral-500">(optional)</span></label><div className="flex overflow-hidden rounded-xl border border-white/10 bg-black/20 focus-within:border-violet-400/40"><span className="flex items-center border-r border-white/10 px-3 text-xs text-neutral-500">omnilume.com/r/</span><input id="room-username" name="username" type="text" placeholder="my_custom_room" className="min-w-0 flex-1 bg-transparent px-3 py-3 text-sm text-white outline-none" /></div><p className="form-help">A memorable link people can use to find your room.</p></div>

            {templates.length > 0 && <div><label className="form-label" htmlFor="room-template">Start from a template <span className="text-neutral-500">(optional)</span></label><select id="room-template" className="omni-input" value={templateId} onChange={(event) => chooseTemplate(event.target.value)}><option value="">No template</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}{template.builtin_key ? '' : ' (yours)'}</option>)}</select><p className="form-help">Fills in privacy and lifespan and sets features, layout, theme and rules.</p></div>}

            <div><p className="form-label">Room lifespan</p><div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => setIsTemp(false)} className={`omni-button ${!isTemp ? 'omni-button-primary' : 'omni-button-ghost'}`}>Permanent</button><button type="button" onClick={() => setIsTemp(true)} className={`omni-button ${isTemp ? 'omni-button-primary' : 'omni-button-ghost'}`}>Temporary</button></div></div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"><label className="flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-neutral-300"><input type="checkbox" checked={isScheduled} onChange={(event) => setIsScheduled(event.target.checked)} className="mt-0.5 h-4 w-4 accent-violet-400" /><span><strong className="text-white">Schedule room opening</strong><br /><span className="text-neutral-500">Members can see the scheduled room, but no one can join before it opens.</span></span></label>{isScheduled && <label className="mt-4 block"><span className="form-label">Opens at</span><input name="scheduled_for" type="datetime-local" required={isScheduled} className="omni-input" /></label>}</div>

            {isTemp && <div className="rounded-2xl border border-amber-300/20 bg-amber-200/[0.04] p-4"><div><label className="form-label text-amber-100" htmlFor="expires-hours">Self-destruct timer (hours)</label><input id="expires-hours" name="expires_in_hours" type="number" min="1" max="720" required value={hours} onChange={(event) => setHours(Number(event.target.value))} className="omni-input border-amber-300/20" /></div><label className="mt-4 flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-neutral-300"><input type="checkbox" checked={allowRecovery} onChange={(e) => setAllowRecovery(e.target.checked)} className="mt-0.5 h-4 w-4 accent-amber-400" /><span><strong className="text-amber-100">Enable quarantine:</strong> When the timer ends, the owner or an admin has 7 days to request recovery. If nobody asks, the room and all of its chats and files are permanently deleted. If unchecked, everything is deleted as soon as the timer ends.</span></label></div>}

            <div className="h-px bg-white/10" />
            <div className="grid gap-3"><label className="flex cursor-pointer items-center gap-3 text-sm text-neutral-300"><input type="checkbox" name="is_private" value="true" id="private-toggle" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} className="h-4 w-4 accent-neutral-300" /><span><strong className="text-white">Private space</strong> <span className="text-neutral-500">(requires approval)</span></span></label></div>

            <button type="submit" disabled={loading} className="omni-button omni-button-primary mt-3 w-full">{loading ? 'Creating room...' : 'Launch room'} <OmniIcon name="arrow" size={15} /></button>
          </div>
        </form>
      </main>
      <FloatingDock />
    </div>
  );
}
