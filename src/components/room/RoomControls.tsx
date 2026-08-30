"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

type ControlButtonProps = {
  label: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
};

function ControlButton({
  label,
  active,
  danger,
  onClick,
  children,
}: ControlButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`flex h-12 w-12 items-center justify-center rounded-full border transition ${
        danger
          ? "border-red-500/30 bg-red-500 text-white hover:bg-red-400"
          : active
            ? "border-white/20 bg-white text-zinc-950"
            : "border-white/10 bg-white/10 text-zinc-100 hover:bg-white/15"
      }`}
    >
      {children}
    </button>
  );
}

export function RoomControls() {
  const router = useRouter();
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sharing, setSharing] = useState(false);

  return (
    <footer className="border-t border-white/10 bg-[#0a0a0a]/90 px-4 py-3 backdrop-blur-xl">
      <div className="mx-auto flex max-w-3xl items-center justify-center gap-3">
        <ControlButton
          label={muted ? "Unmute" : "Mute"}
          active={muted}
          onClick={() => setMuted((value) => !value)}
        >
          {muted ? (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v3" />
              <path d="M4 4l16 16" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v3" />
            </svg>
          )}
        </ControlButton>

        <ControlButton
          label={cameraOn ? "Turn camera off" : "Turn camera on"}
          active={cameraOn}
          onClick={() => setCameraOn((value) => !value)}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="7" width="12" height="10" rx="2" />
            <path d="M15 11l6-3v8l-6-3" />
            {!cameraOn ? <path d="M4 4l16 16" /> : null}
          </svg>
        </ControlButton>

        <ControlButton
          label={sharing ? "Stop sharing" : "Share"}
          active={sharing}
          onClick={() => setSharing((value) => !value)}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M8 20h8" />
            <path d="M12 16v4" />
          </svg>
        </ControlButton>

        <ControlButton label="Leave room" danger onClick={() => router.push("/")}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M10 7V5a2 2 0 0 1 2-2h7v18h-7a2 2 0 0 1-2-2v-2" />
            <path d="M15 12H4" />
            <path d="M7 9l-3 3 3 3" />
          </svg>
        </ControlButton>
      </div>
    </footer>
  );
}
