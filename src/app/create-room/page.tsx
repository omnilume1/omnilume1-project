'use client';

import { unwrapAction } from '@/lib/action-result';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listRoomTemplates, type RoomTemplate } from '@/lib/management-data';
import { useRouter } from 'next/navigation';
import { createRoom } from '@/actions/rooms';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import { OmniIcon, type OmniIconName } from '@/components/ui/OmniIcon';
import FlippingWords from '@/components/ui/FlippingWords';
import styles from './create.module.css';

// Built-in templates get their feature's icon; ones you saved get a spark.
const TEMPLATE_ICONS: Record<string, OmniIconName> = { 'study-session': 'book', 'watch-party': 'tv', 'project-room': 'layout' };

export default function CreateRoomPage() {
  const [loading, setLoading] = useState(false);
  const [isTemp, setIsTemp] = useState(false);
  const [allowRecovery, setAllowRecovery] = useState(true);
  const [isScheduled, setIsScheduled] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [hours, setHours] = useState(24);
  const [templates, setTemplates] = useState<RoomTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [opensAt, setOpensAt] = useState('');
  const [done, setDone] = useState(false);
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
      setDone(true);
      await new Promise((resolve) => setTimeout(resolve, 650));
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
        <div className={styles.stage}>
        <form onSubmit={handleSubmit} className={`glass-strong omni-form-card create-room-sheet rise ${styles.sheet}`}>
          <p className="section-kicker">New shared space</p>
          <h2>Bring people together.</h2>
          <p className="section-copy mb-8">Choose a name, set the room rules and invite people when you are ready.</p>
          <FlippingWords
            prefix="CREATE A ROOM ·"
            phrases={["GROW TOGETHER", "STUDY TOGETHER", "WATCH TOGETHER"]}
            className="create-room-flipping-words"
          />

          <ol className={styles.steps} aria-label="Form sections">
            <li className={styles.step}><b>1</b>Name</li>
            <li className={styles.step}><b>2</b>Lifespan</li>
            <li className={styles.step}><b>3</b>Opening</li>
            <li className={styles.step}><b>4</b>Access</li>
          </ol>

          <div className="grid gap-5">
            <div><label className="form-label" htmlFor="room-name">Room name <span className="text-violet-300">*</span></label><input id="room-name" name="name" type="text" required placeholder="e.g. Late Night Study" value={name} onChange={(event) => setName(event.target.value)} className="omni-input" /></div>
            <div><label className="form-label" htmlFor="room-username">Custom link <span className="text-neutral-500">(optional)</span></label><div className="flex overflow-hidden rounded-xl border border-white/10 bg-black/20 focus-within:border-violet-400/40"><span className="flex items-center border-r border-white/10 px-3 text-xs text-neutral-500">omnilume.com/r/</span><input id="room-username" name="username" type="text" placeholder="my_custom_room" value={username} onChange={(event) => setUsername(event.target.value)} className="min-w-0 flex-1 bg-transparent px-3 py-3 text-sm text-white outline-none" /></div><p className="form-help">A memorable link people can use to find your room.</p></div>

            {templates.length > 0 && (
              <div>
                <p className="form-label" id="room-template">Start from a template <span className="text-neutral-500">(optional)</span></p>
                {/* Pick a card to fill the form from it; pick it again to start from scratch. */}
                <div className="template-cards" role="group" aria-labelledby="room-template">
                  {templates.map((template) => (
                    <button key={template.id} type="button" className="template-card" aria-pressed={templateId === template.id} onClick={() => chooseTemplate(templateId === template.id ? '' : template.id)}>
                      <OmniIcon name={TEMPLATE_ICONS[template.builtin_key ?? ''] ?? 'spark'} size={18} />
                      <strong>{template.name}{template.builtin_key ? '' : ' (yours)'}</strong>
                      {template.description && <small>{template.description}</small>}
                    </button>
                  ))}
                </div>
                <p className="form-help">Fills in privacy and lifespan and sets features, layout, theme and rules.</p>
              </div>
            )}

            <div><p className="form-label" id="room-lifespan">Room lifespan</p><div className="omni-seg" role="group" aria-labelledby="room-lifespan"><button type="button" aria-pressed={!isTemp} onClick={() => setIsTemp(false)}>Permanent</button><button type="button" aria-pressed={isTemp} onClick={() => setIsTemp(true)}>Temporary</button></div></div>

            <div className="omni-row-card"><label className="omni-row-toggle"><OmniIcon name="calendar" size={16} className="omni-row-icon" /><span><strong>Schedule room opening</strong><small>Members can see the scheduled room, but no one can join before it opens.</small></span><input type="checkbox" checked={isScheduled} onChange={(event) => setIsScheduled(event.target.checked)} className="omni-switch" /></label>{isScheduled && <label className="mt-4 block"><span className="form-label">Opens at</span><input name="scheduled_for" type="datetime-local" required={isScheduled} value={opensAt} onChange={(event) => setOpensAt(event.target.value)} className="omni-input" /></label>}</div>

            {isTemp && <div className="rounded-2xl border border-amber-300/20 bg-amber-200/[0.04] p-4"><div><label className="form-label text-amber-100" htmlFor="expires-hours">Self-destruct timer (hours)</label><input id="expires-hours" name="expires_in_hours" type="number" min="1" max="720" required value={hours} onChange={(event) => setHours(Number(event.target.value))} className="omni-input border-amber-300/20" /></div><label className="mt-4 flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-neutral-300"><input type="checkbox" checked={allowRecovery} onChange={(e) => setAllowRecovery(e.target.checked)} className="mt-0.5 h-4 w-4 accent-amber-400" /><span><strong className="text-amber-100">Enable quarantine:</strong> When the timer ends, the owner or an admin has 7 days to request recovery. If nobody asks, the room and all of its chats and files are permanently deleted. If unchecked, everything is deleted as soon as the timer ends.</span></label></div>}

            <div className="h-px bg-white/10" />
            <div className="omni-row-card"><label className="omni-row-toggle" htmlFor="private-toggle"><OmniIcon name="lock" size={16} className="omni-row-icon" /><span><strong>Private space</strong><small>(requires approval)</small></span><input type="checkbox" name="is_private" value="true" id="private-toggle" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} className="omni-switch" /></label></div>

            <div className="create-room-foot"><Link href="/explore" className="omni-button omni-button-ghost">Back to explore</Link><button type="submit" disabled={loading} className="omni-button omni-button-primary">{loading ? 'Creating room...' : 'Launch room'} <OmniIcon name="arrow" size={15} /></button></div>
          </div>
        </form>

        <aside className={styles.preview} aria-label="Room preview">
          <p className={styles.previewLabel}>Preview · how it shows up in Explore</p>
          <div className={styles.board}>
            <div className={styles.outline} aria-hidden="true" />
            <span className={styles.dimW} aria-hidden="true">360</span>
            <span className={styles.dimH} aria-hidden="true">220</span>
            <span className={`${styles.call} ${styles.callName}`} aria-hidden="true">Name</span>
            <span className={`${styles.call} ${styles.callAccess}`} aria-hidden="true">Access</span>
            <div className={`${styles.card} ${done ? styles.glow : ''}`}>
              <span className={styles.badge}><OmniIcon name={isPrivate ? 'lock' : TEMPLATE_ICONS[templates.find((t) => t.id === templateId)?.builtin_key ?? ''] ?? 'spark'} size={22} /></span>
              {isScheduled && opensAt && !Number.isNaN(Date.parse(opensAt)) && <span key={opensAt} className={`${styles.when} ${styles.pop}`}>Opens {new Date(opensAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>}
              <h3 key={name} className={`${styles.title} ${styles.pop} ${name.trim() ? '' : styles.ghost}`}>{name.trim() || 'Your room name'}</h3>
              <p className={styles.sub}>omnilume.com/r/{username.trim() || 'your_link'}</p>
              <div className={styles.chips}>
                <span key={String(isPrivate)} className={`${styles.chip} ${styles.pop}`}>{isPrivate ? 'Private' : 'Public'}</span>
                <span key={`${isTemp}-${hours}-${allowRecovery}`} className={`${styles.chip} ${styles.pop}`}>{isTemp ? `Ends in ${hours}h${allowRecovery ? ' · recoverable' : ''}` : 'Permanent'}</span>
                {templateId && <span className={styles.chip}>{templates.find((t) => t.id === templateId)?.name}</span>}
              </div>
            </div>
          </div>
        </aside>
        </div>
      </main>
      <FloatingDock />
    </div>
  );
}
