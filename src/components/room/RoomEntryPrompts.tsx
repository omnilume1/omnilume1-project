'use client';

import { useEffect, useState } from 'react';
import { getRoomControlState } from '@/actions/room-controls';

type Prompt = 'rules' | 'profile' | null;

export default function RoomEntryPrompts({ roomId, onOpenRoomProfile }: { roomId: string; onOpenRoomProfile: () => void }) {
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [welcome, setWelcome] = useState('');
  const [rules, setRules] = useState('');

  useEffect(() => {
    let active = true;

    void getRoomControlState(roomId).then((state) => {
      if (!active) return;
      const nextWelcome = state.settings?.welcome_message ?? '';
      const nextRules = state.settings?.rules ?? '';
      setWelcome(nextWelcome);
      setRules(nextRules);
      setPrompt(nextWelcome || nextRules ? 'rules' : 'profile');
    }).catch(() => {
      // Entry prompts are additive; room access remains authoritative.
    });

    return () => { active = false; };
  }, [roomId]);

  if (!prompt) return null;

  const closeRules = () => setPrompt('profile');
  const closeProfile = () => setPrompt(null);

  return <div className="fixed inset-0 z-[75] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="room-entry-prompt-title">
    <section className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#111217] p-5 shadow-2xl sm:p-6">
      {prompt === 'rules' ? <>
        <p className="text-[10px] font-bold uppercase tracking-[.16em] text-violet-200">Room entry</p>
        <h2 id="room-entry-prompt-title" className="mt-2 text-xl font-semibold text-white">Welcome to the room</h2>
        {welcome && <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-neutral-200">{welcome}</p>}
        {rules && <div className="mt-4 whitespace-pre-wrap rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm leading-6 text-neutral-300"><p className="mb-2 text-[10px] font-bold uppercase tracking-[.16em] text-violet-200">Room rules</p>{rules}</div>}
        <div className="mt-6 flex justify-end"><button type="button" onClick={closeRules} className="omni-button omni-button-primary">Continue</button></div>
      </> : <>
        <p className="text-[10px] font-bold uppercase tracking-[.16em] text-violet-200">Room identity</p>
        <h2 id="room-entry-prompt-title" className="mt-2 text-xl font-semibold text-white">Would you like to update your room profile?</h2>
        <p className="mt-3 text-sm leading-6 text-neutral-400">This optional profile is only used in this room and does not change your global OmniLume profile.</p>
        <div className="mt-6 flex flex-wrap justify-end gap-3"><button type="button" onClick={closeProfile} className="omni-button omni-button-ghost">Later</button><button type="button" onClick={() => { closeProfile(); onOpenRoomProfile(); }} className="omni-button omni-button-primary">Yes</button></div>
      </>}
    </section>
  </div>;
}
