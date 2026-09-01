"use client";

import Link from "next/link";
import { useState } from "react";
import MediaStage from "@/components/room/MediaStage";
import { RoomControls } from "@/components/room/RoomControls";
import { RoomSidebar } from "@/components/room/RoomSidebar";
import GlobalFocusTrap from "@/components/GlobalFocusTrap";
import RoomRealtimeProvider from "@/components/room/RoomRealtimeProvider";
import { useRoomSync } from "@/hooks/useRoomSync";
import { useRoomPresence } from "@/hooks/useRoomPresence";

// Added currentUserRole to the props
export function RoomShell({
  roomId,
  currentUserRole = "user"
}: {
  roomId: string;
  currentUserRole?: string;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const roomSync = useRoomSync(roomId, currentUserRole === "owner" || currentUserRole === "admin");
  const roomPresence = useRoomPresence(roomId);

  return (
    <RoomRealtimeProvider sync={roomSync} presence={roomPresence}>
      <div className="flex h-dvh min-h-0 flex-col bg-background">
      <GlobalFocusTrap />

      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="relative flex h-6 w-6 items-center justify-center">
            <span className="absolute inset-0 rounded-full bg-accent/40 blur-md" />
            <span className="relative h-3 w-3 rounded-full bg-accent-soft" />
          </span>
          <span className="text-sm font-medium text-white">Omnilume</span>
        </Link>

        <div className="flex items-center gap-2">
          <p className="rounded-full border border-white/10 bg-white/5 px-3 py-1 font-mono text-xs tracking-wider text-zinc-300">
            {roomId}
          </p>
          <button
            type="button"
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-300 lg:hidden"
            onClick={() => setSidebarOpen((value) => !value)}
          >
            {sidebarOpen ? "Close" : "Chat"}
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* Passed the currentUserRole prop to MediaStage */}
        <MediaStage roomId={roomId} currentUserRole={currentUserRole} />

        <div
          className={`${sidebarOpen ? "absolute inset-y-0 right-0 z-20 flex w-[min(100%,20rem)] shadow-2xl" : "hidden"} lg:relative lg:flex lg:w-80 lg:shadow-none`}
        >
          <RoomSidebar />
        </div>
      </div>

      <RoomControls />
      </div>
    </RoomRealtimeProvider>
  );
}
