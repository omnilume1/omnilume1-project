"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createLocalRoomCode, normalizeRoomId } from "@/lib/room";

export function LandingActions() {
  const router = useRouter();
  const [joinCode, setJoinCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  function handleCreateRoom() {
    const code = createLocalRoomCode();
    router.push(`/room/${code}`);
  }

  function handleJoinRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = normalizeRoomId(joinCode);

    if (!code) {
      setStatus("Enter a room code to continue.");
      return;
    }

    router.push(`/room/${code}`);
  }

  return (
    <div className="mx-auto mt-10 w-full max-w-xl">
      <div className="glass-strong rounded-3xl p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={handleCreateRoom}
            className="inline-flex h-12 shrink-0 items-center justify-center rounded-2xl bg-white px-6 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200"
          >
            Create Room
          </button>

          <form
            onSubmit={handleJoinRoom}
            className="flex min-w-0 flex-1 gap-2"
          >
            <label htmlFor="join-room" className="sr-only">
              Join Room
            </label>
            <input
              id="join-room"
              name="join-room"
              value={joinCode}
              onChange={(event) => {
                setJoinCode(event.target.value.toUpperCase());
                if (status) setStatus(null);
              }}
              placeholder="Enter room code"
              autoComplete="off"
              spellCheck={false}
              className="h-12 min-w-0 flex-1 rounded-2xl border border-white/10 bg-black/40 px-4 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-accent/50"
            />
            <button
              type="submit"
              className="h-12 shrink-0 rounded-2xl border border-white/10 bg-white/10 px-4 text-sm font-medium text-zinc-100 transition hover:bg-white/15"
            >
              Join Room
            </button>
          </form>
        </div>
      </div>

      {status ? (
        <p className="mt-4 text-center text-sm text-zinc-400">{status}</p>
      ) : (
        <p className="mt-4 text-center text-sm text-zinc-500">
          No account required for this preview.
        </p>
      )}
    </div>
  );
}
