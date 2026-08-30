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
  
  // This hook auto-fetches and decrypts messages in real-time
  const { messages } = usePrivateChat(chatId, sharedKey);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !sharedKey || isSending) return;

    setIsSending(true);
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
    } catch (error) {
      console.error("Failed to send message:", error);
      // Restore text if it failed
      setInputText(textToSend);
    } finally {
      setIsSending(false);
    }
  };

  if (!sharedKey) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-500 text-sm">
        Negotiating secure connection... 🔒
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#050505] border border-neutral-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="h-14 border-b border-neutral-800 bg-[#0a0a0a] flex items-center px-4 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-emerald-500 text-xs">🔒</span>
          <h3 className="font-medium text-sm text-white">End-to-End Encrypted Chat</h3>
        </div>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {messages.length === 0 ? (
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
                <div className={`p-3 rounded-lg text-sm max-w-[80%] ${
                  isMe 
                    ? 'bg-neutral-200 text-black rounded-tr-sm' 
                    : 'bg-neutral-900 text-white border border-neutral-800 rounded-tl-sm'
                }`}>
                  {msg.text}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Input Area */}
      <form onSubmit={handleSendMessage} className="p-4 border-t border-neutral-800 bg-[#0a0a0a] flex gap-2 shrink-0">
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Type an encrypted message..."
          className="flex-1 bg-[#050505] border border-neutral-800 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-neutral-500 transition placeholder-neutral-600"
          disabled={isSending}
        />
        <button
          type="submit"
          disabled={!inputText.trim() || isSending}
          className="px-4 py-2 bg-white text-black text-sm font-semibold rounded-md disabled:opacity-50 transition hover:bg-neutral-200"
        >
          {isSending ? '...' : 'Send'}
        </button>
      </form>
    </div>
  );
}