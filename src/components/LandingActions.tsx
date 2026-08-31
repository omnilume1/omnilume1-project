"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { processRoomJoin } from "@/actions/rooms";

export function LandingActions() {
  const router = useRouter();
  const [joinCode, setJoinCode] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    type: "info" | "error" | "success" | "pending";
  } | null>(null);

  function handleCreateRoom() {
    router.push("/create-room");
  }

  async function handleJoinRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = joinCode.trim();

    if (!trimmed) {
      setMessage({ text: "Please enter a room code, username, or link.", type: "error" });
      return;
    }

    setIsJoining(true);
    setMessage(null);

    try {
      const result = await processRoomJoin(trimmed);

      if (result.status === "approved") {
        router.push(`/room/${result.roomId}`);
      } else if (result.status === "pending") {
        setMessage({
          text: "Your request has been sent. You will be able to join once a room admin approves you.",
          type: "pending",
        });
      } else {
        setMessage({
          text: `Unexpected status: ${result.status}. Please try again.`,
          type: "error",
        });
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);

      if (msg === "Unauthorized" || msg.toLowerCase().includes("unauthorized")) {
        setMessage({
          text: "Please sign in to join a room.",
          type: "info",
        });
      } else if (msg.toLowerCase().includes("not found")) {
        setMessage({
          text: "We could not find a room with that code or link. Please check and try again.",
          type: "error",
        });
      } else {
        setMessage({
          text: msg || "Something went wrong. Please try again.",
          type: "error",
        });
      }
    } finally {
      setIsJoining(false);
    }
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
                setJoinCode(event.target.value);
                if (message) setMessage(null);
              }}
              placeholder="Room code, username, or link"
              autoComplete="off"
              spellCheck={false}
              disabled={isJoining}
              className="h-12 min-w-0 flex-1 rounded-2xl border border-white/10 bg-black/40 px-4 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-accent/50 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isJoining}
              className="h-12 shrink-0 rounded-2xl border border-white/10 bg-white/10 px-4 text-sm font-medium text-zinc-100 transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isJoining ? "Joining..." : "Join Room"}
            </button>
          </form>
        </div>
      </div>

      {message && (
        <p
          className={`mt-4 text-center text-sm ${
            message.type === "error"
              ? "text-red-400"
              : message.type === "pending"
              ? "text-amber-400"
              : message.type === "success"
              ? "text-emerald-400"
              : "text-zinc-400"
          }`}
        >
          {message.text}
          {message.type === "info" && (
            <>
              {" "}
              <Link
                href="/login"
                className="underline hover:text-zinc-200"
              >
                Sign in
              </Link>
            </>
          )}
        </p>
      )}

      {!message && (
        <p className="mt-4 text-center text-sm text-zinc-500">
          Sign in to create or join a room.
        </p>
      )}
    </div>
  );
}
