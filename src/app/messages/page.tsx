'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import PrivateChat from '@/components/chat/PrivateChat';
import { 
  generateKeyPair, 
  exportPublicKey, 
  exportPrivateKey, 
  importPrivateKey, 
  deriveSharedKey 
} from '@/lib/encryption';
import { saveUserPublicKey, getUserPublicKey, getOrCreatePrivateChat } from '@/actions/chat';

export default function MessagesPage() {
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [myPrivateKey, setMyPrivateKey] = useState<CryptoKey | null>(null);
  
  const [friendIdInput, setFriendIdInput] = useState('');
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [sharedKey, setSharedKey] = useState<CryptoKey | null>(null);
  const [status, setStatus] = useState('Initializing secure environment...');

  const supabase = createClient();

  // 1. Authenticate and Load/Generate Keys on mount
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
          // Load existing key
          const privateKey = await importPrivateKey(JSON.parse(storedJwk));
          setMyPrivateKey(privateKey);
          setStatus('Ready.');
        } else {
          // Generate brand new keys
          setStatus('Generating cryptographic keys...');
          const keyPair = await generateKeyPair();
          setMyPrivateKey(keyPair.privateKey);
          
          // Save private key locally
          const jwk = await exportPrivateKey(keyPair.privateKey);
          localStorage.setItem(`privKey_${user.id}`, JSON.stringify(jwk));
          
          // Publish public key to Supabase
          const pubKeyBase64 = await exportPublicKey(keyPair.publicKey);
          await saveUserPublicKey(pubKeyBase64);
          setStatus('Ready.');
        }
      } catch {
        console.error('Secure chat initialization failed.');
        setStatus('Error initializing cryptography.');
      }
    }
    initializeCrypto();
  }, [supabase]);

  // 2. Start Chat with a Friend
  const handleStartChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!friendIdInput.trim() || !myPrivateKey || !currentUserId) return;

    setStatus('Negotiating secure tunnel...');
    try {
      // Fetch friend's public key
      const friendPubKeyBase64 = await getUserPublicKey(friendIdInput.trim());
      if (!friendPubKeyBase64) {
        setStatus("Friend's public key not found. They must log in first.");
        return;
      }

      // Derive the AES-GCM shared key
      const derivedKey = await deriveSharedKey(myPrivateKey, friendPubKeyBase64);
      setSharedKey(derivedKey);

      // Get or Create the database chat room
      const chatId = await getOrCreatePrivateChat(friendIdInput.trim());
      setActiveChatId(chatId);
      setStatus('Secure tunnel established.');
      
    } catch {
      console.error('Secure chat connection failed.');
      setStatus('Failed to connect to friend.');
    }
  };

  if (!currentUserId) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <p className="text-neutral-400">{status}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] text-white flex flex-col items-center p-6 font-sans">
      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-3 gap-6 h-[80vh]">
        
        {/* Left Sidebar - Connection Manager */}
        <div className="col-span-1 bg-[#0a0a0a] border border-neutral-800 rounded-xl p-6 flex flex-col gap-6">
          <div>
            <h2 className="text-lg font-semibold mb-1">E2EE Messaging</h2>
            <p className="text-xs text-emerald-500 font-medium">{status}</p>
          </div>

          <div className="bg-neutral-900 p-4 rounded-lg border border-neutral-800">
            <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-2">Your User ID (Share this)</label>
            <code className="text-xs text-neutral-300 break-all select-all">{currentUserId}</code>
          </div>

          <form onSubmit={handleStartChat} className="flex flex-col gap-3 mt-4">
            <label className="block text-[10px] uppercase tracking-wider text-neutral-500">Connect to Friend</label>
            <input
              type="text"
              placeholder="Paste Friend's User ID..."
              value={friendIdInput}
              onChange={(e) => setFriendIdInput(e.target.value)}
              className="w-full bg-[#050505] border border-neutral-800 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-neutral-500 text-white"
              required
            />
            <button
              type="submit"
              className="w-full py-2.5 bg-white text-black font-semibold text-sm rounded-md hover:bg-neutral-200 transition disabled:opacity-50"
              disabled={!myPrivateKey || !friendIdInput.trim()}
            >
              Start Secure Chat
            </button>
          </form>
        </div>

        {/* Right Area - Active Chat Interface */}
        <div className="col-span-1 md:col-span-2 h-full">
          {activeChatId && sharedKey ? (
            <PrivateChat 
              chatId={activeChatId} 
              currentUserId={currentUserId} 
              receiverId={friendIdInput.trim()} 
              sharedKey={sharedKey} 
            />
          ) : (
            <div className="h-full border border-neutral-800 border-dashed rounded-xl flex items-center justify-center bg-[#0a0a0a]/50 text-neutral-600 text-sm">
              Select a friend to start chatting
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
