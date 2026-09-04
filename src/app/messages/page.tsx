'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/client';
import PrivateChat from '@/components/chat/PrivateChat';
import { generateKeyPair, exportPublicKey, exportPrivateKey, importPrivateKey, deriveSharedKey } from '@/lib/encryption';
import { saveUserPublicKey, getUserPublicKey, getOrCreatePrivateChat } from '@/actions/chat';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import { OmniIcon } from '@/components/ui/OmniIcon';

export default function MessagesPage() {
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [myPrivateKey, setMyPrivateKey] = useState<CryptoKey | null>(null);
  const [friendIdInput, setFriendIdInput] = useState('');
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [sharedKey, setSharedKey] = useState<CryptoKey | null>(null);
  const [status, setStatus] = useState('Initializing secure environment...');
  const supabase = createClient();

  useEffect(() => {
    async function initializeCrypto() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setStatus('You must be logged in to use secure messaging.');
        return;
      }
      setCurrentUserId(user.id);
      try {
        const storedJwk = localStorage.getItem(`privKey_${user.id}`);
        if (storedJwk) {
          const privateKey = await importPrivateKey(JSON.parse(storedJwk));
          setMyPrivateKey(privateKey);
          setStatus('Ready.');
        } else {
          setStatus('Generating cryptographic keys...');
          const keyPair = await generateKeyPair();
          setMyPrivateKey(keyPair.privateKey);
          const jwk = await exportPrivateKey(keyPair.privateKey);
          localStorage.setItem(`privKey_${user.id}`, JSON.stringify(jwk));
          const pubKeyBase64 = await exportPublicKey(keyPair.publicKey);
          await saveUserPublicKey(pubKeyBase64);
          setStatus('Ready.');
        }
      } catch {
        console.error('Secure chat initialization failed.');
        setStatus('Error initializing cryptography.');
      }
    }
    void initializeCrypto();
  }, [supabase]);

  const handleStartChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!friendIdInput.trim() || !myPrivateKey || !currentUserId) return;
    setStatus('Negotiating secure tunnel...');
    try {
      const friendPubKeyBase64 = await getUserPublicKey(friendIdInput.trim());
      if (!friendPubKeyBase64) {
        setStatus("Friend's public key not found. They must log in first.");
        return;
      }
      const derivedKey = await deriveSharedKey(myPrivateKey, friendPubKeyBase64);
      setSharedKey(derivedKey);
      const chatId = await getOrCreatePrivateChat(friendIdInput.trim());
      setActiveChatId(chatId);
      setStatus('Secure tunnel established.');
    } catch {
      console.error('Secure chat connection failed.');
      setStatus('Failed to connect to friend.');
    }
  };

  if (!currentUserId) return <div className="omni-state-screen text-sm text-neutral-400">{status}</div>;

  return (
    <div className="omni-internal">
      <InternalTopbar eyebrow="Private, by design" title="Messages" description="End-to-end encrypted conversations stay on your devices." actions={<Link href="/home" className="omni-button omni-button-ghost">Back home</Link>} />
      <main className="omni-main-content">
        <div className="grid min-h-[70vh] gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="glass-panel flex flex-col gap-6">
            <div><p className="section-kicker">Your secure space</p><h2 className="text-xl font-semibold text-white">E2EE messaging</h2><p className="mt-2 text-xs text-cyan-200">{status}</p></div>
            <div className="rounded-xl border border-white/10 bg-black/25 p-4"><div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-neutral-500"><OmniIcon name="shield" size={13} /> Local identity</div><code className="block break-all text-xs text-neutral-300 select-all">{currentUserId}</code></div>
            <form onSubmit={handleStartChat} className="mt-auto grid gap-3"><label className="form-label" htmlFor="friend-id">Connect to a friend</label><input id="friend-id" type="text" placeholder="Paste friend's user ID..." value={friendIdInput} onChange={(e) => setFriendIdInput(e.target.value)} className="omni-input" required /><button type="submit" className="omni-button omni-button-primary w-full" disabled={!myPrivateKey || !friendIdInput.trim()}><OmniIcon name="message" size={15} /> Start secure chat</button></form>
          </aside>
          <section className="min-h-[520px]">{activeChatId && sharedKey ? <PrivateChat chatId={activeChatId} currentUserId={currentUserId} receiverId={friendIdInput.trim()} sharedKey={sharedKey} /> : <div className="glass-panel flex h-full min-h-[520px] flex-col items-center justify-center text-center"><span className="feature-float-icon"><OmniIcon name="message" size={19} /></span><h2 className="mt-5 text-lg font-semibold text-white">Choose a friend to begin</h2><p className="mt-2 max-w-sm text-sm text-neutral-500">Your messages are encrypted in the browser before they leave your device.</p></div>}</section>
        </div>
      </main>
      <FloatingDock />
    </div>
  );
}
