"use client";

import { FormEvent, useState } from "react";

const MOCK_PARTICIPANTS = [
  { name: "You", role: "Owner", you: true },
  { name: "Aria", role: "Member", you: false },
  { name: "Rohan", role: "Member", you: false },
];

type ChatMessage = {
  id: string;
  author: string;
  body: string;
  system?: boolean;
};

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "sys-1",
    author: "Omnilume",
    body: "Chat is a local mock. Messages stay in this browser tab.",
    system: true,
  },
  {
    id: "msg-1",
    author: "Aria",
    body: "Ready when you are.",
  },
];

export function RoomSidebar() {
  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [draft, setDraft] = useState("");

  function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;

    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), author: "You", body },
    ]);
    setDraft("");
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-white/10 bg-[#0c0c0c] lg:w-80 lg:border-l">
      <div className="border-b border-white/10 px-4 py-3">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">
          Participants
        </p>
        <ul className="mt-3 space-y-2">
          {MOCK_PARTICIPANTS.map((person) => (
            <li key={person.name} className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-xs text-zinc-200">
                {person.name.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-zinc-100">
                  {person.name}
                </span>
                <span className="text-xs text-zinc-500">{person.role}</span>
              </span>
              {person.you ? (
                <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-zinc-400">
                  You
                </span>
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80" />
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <p className="px-4 pt-3 text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">
          Chat
        </p>
        <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-3">
          {messages.map((message) => (
            <div key={message.id}>
              <p
                className={`text-xs ${message.system ? "text-zinc-500" : "text-zinc-400"}`}
              >
                {message.author}
              </p>
              <p
                className={`mt-1 text-sm leading-5 ${message.system ? "text-zinc-500" : "text-zinc-200"}`}
              >
                {message.body}
              </p>
            </div>
          ))}
        </div>

        <form
          onSubmit={handleSend}
          className="border-t border-white/10 p-3"
        >
          <label htmlFor="room-chat" className="sr-only">
            Send a message
          </label>
          <div className="flex gap-2">
            <input
              id="room-chat"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message the room"
              className="h-10 min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-accent/50"
            />
            <button
              type="submit"
              className="h-10 rounded-xl bg-white px-3 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200"
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </aside>
  );
}
