'use client';

import { useState } from 'react';
import { usePrivateChat } from '@/hooks/usePrivateChat';
import { sendEncryptedMessage } from '@/actions/chat';
import { encryptMessage } from '@/lib/encryption';

interface PrivateChatProps {
  chatId: string;
  currentUserId: string;
  receiverId: string;
  sharedKey: CryptoKey | null;
}

export default function PrivateChat({ chatId, currentUserId, receiverId, sharedKey }: PrivateChatProps) {
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  
  // This hook auto-fetches and decrypts messages in real-time
  const { messages, status, error, retry } = usePrivateChat(chatId, sharedKey);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !sharedKey || isSending) return;

    setIsSending(true);
    setSendError(null);
    const textToSend = inputText;
    setInputText(''); // Clear input instantly for better UX

    try {
      // 1. Encrypt in the browser FIRST
      const { ciphertext, iv } = await encryptMessage(textToSend, sharedKey);

      // 2. Send the scrambled ciphertext to the server
      await sendEncryptedMessage({
        chatId,
        receiverId,
        ciphertext,
        iv
      });
    } catch {
      setSendError('Unable to send the encrypted message. Please try again.');
      // Restore text if it failed
      setInputText(textToSend);
    } finally {
      setIsSending(false);
    }
  };

  if (!sharedKey) {
    return (
      <div className="omni-state-screen h-full min-h-0 text-neutral-500 text-sm">
        Negotiating secure connection... 🔒
      </div>
    );
  }

  return (
    <div className="chat-panel h-full overflow-hidden rounded-2xl border border-white/10">
      {/* Header */}
      <div className="chat-topbar shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-emerald-500 text-xs">🔒</span>
          <h3 className="font-medium text-sm text-white">End-to-End Encrypted Chat</h3>
        </div>
        <details className="relative ml-auto text-right">
          <summary className="cursor-pointer text-[10px] text-neutral-500 hover:text-neutral-300">
            About message recovery
          </summary>
          <div className="absolute right-0 top-6 z-10 w-72 rounded-xl border border-white/15 bg-[#121318] p-3 text-left text-[11px] leading-relaxed text-neutral-400 shadow-xl">
            Messages are decrypted only on a device with the required key. A missing, changed, or rotated key can make older messages unavailable. Additional devices do not automatically receive older keys; re-keying or resending may be required. The server cannot recover a message without its private key.
          </div>
        </details>
      </div>

      {/* Messages Area */}
      <div className="chat-scroller flex flex-col gap-4" aria-live="polite">
        {status === 'loading' ? (
          <div className="text-center text-xs text-neutral-500 my-auto">Loading encrypted messages...</div>
        ) : status === 'error' ? (
          <div className="my-auto flex flex-col items-center gap-3 text-center" role="alert">
            <p className="text-xs text-amber-300">{error}</p>
            <button type="button" onClick={retry} className="rounded-md border border-neutral-700 px-3 py-2 text-xs text-neutral-300 transition hover:border-neutral-500 hover:text-white">
              Try again
            </button>
          </div>
        ) : status === 'ready' && messages.length === 0 ? (
          <div className="text-center text-xs text-neutral-500 my-auto">
            No messages yet. Say hello!
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.sender_id === currentUserId;
            return (
              <div key={msg.id} className={`flex flex-col gap-1 ${isMe ? 'items-end' : 'items-start'}`}>
                <span className="text-[10px] font-semibold text-neutral-500">
                  {isMe ? 'You' : 'Friend'}
                </span>
                <div className={`message-bubble max-w-[80%] p-3 text-sm ${
                  msg.decryptionStatus === 'undecryptable'
                    ? 'border border-amber-500/40 bg-amber-500/10 text-amber-200'
                    : isMe
                      ? 'message-bubble is-own rounded-tr-sm text-white'
                      : 'message-bubble rounded-tl-sm text-white'
                }`} role={msg.decryptionStatus === 'undecryptable' ? 'status' : undefined} aria-label={msg.decryptionStatus === 'undecryptable' ? 'Undecryptable message' : undefined}>
                  {msg.decryptionStatus === 'undecryptable'
                    ? 'This message cannot be decrypted on this device.'
                    : msg.text}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Input Area */}
      {sendError && <p className="border-t border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-300" role="alert">{sendError}</p>}
      <form onSubmit={handleSendMessage} className="message-composer flex shrink-0 gap-2">
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Type an encrypted message..."
          className="omni-input"
          disabled={isSending}
        />
        <button
          type="submit"
          disabled={!inputText.trim() || isSending}
          className="omni-button omni-button-primary"
        >
          {isSending ? '...' : 'Send'}
        </button>
      </form>
    </div>
  );
}
