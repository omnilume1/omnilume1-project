import { Navbar, NavLinks } from "@/components/Navbar";
import { LandingActions } from "@/components/LandingActions";

const features = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
      </svg>
    ),
    title: "Watch Together",
    description: "Stream videos in sync with your room. Cast YouTube, Twitch, or upload files.",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.438 60.438 0 0 0-.491 6.347A48.62 48.62 0 0 1 12 20.904a48.62 48.62 0 0 1 8.232-4.41 60.46 60.46 0 0 0-.491-6.347m-15.482 0a50.636 50.636 0 0 0-2.658-.813A59.906 59.906 0 0 1 12 3.493a59.903 59.903 0 0 1 10.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0 1 12 13.489a50.702 50.702 0 0 1 7.74-3.342M6.75 15a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm0 0v-3.675A55.378 55.378 0 0 1 12 8.443m-7.007 11.55A5.981 5.981 0 0 0 6.75 15.75v-1.5" />
      </svg>
    ),
    title: "Study Together",
    description: "Focus timers, shared sessions, and accountability with your group.",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
      </svg>
    ),
    title: "Chat Together",
    description: "Real-time messaging with end-to-end encrypted private chats.",
  },
];

export default function Home() {
  return (
    <div className="ambient flex min-h-full flex-col">
      <Navbar />
      <NavLinks />

      <main className="relative mx-auto flex w-full max-w-4xl flex-1 flex-col items-center px-6 pb-24 pt-20 text-center sm:pt-28">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs text-zinc-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
          Shared digital spaces
        </div>

        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-6xl sm:leading-[1.08]">
          Watch, study, and talk{" "}
          <span className="text-zinc-400">in one calm room.</span>
        </h1>

        <p className="mt-6 max-w-lg text-base leading-7 text-zinc-500 sm:text-lg">
          Create a room, invite people, and keep chat, media, and tools together — all in one place.
        </p>

        {/* 3D Wireframe Cube — represents rooms/spaces */}
        <div className="mt-16 flex items-center justify-center" style={{ perspective: "600px" }}>
          <div
            className="relative h-28 w-28 sm:h-36 sm:w-36"
            style={{ transformStyle: "preserve-3d" }}
          >
            <div className="absolute inset-0 animate-[spin_18s_linear_infinite]" style={{ transformStyle: "preserve-3d" }}>
              {/* Front */}
              <div className="absolute inset-0 border border-white/15 bg-white/[0.02]" style={{ transform: "translateZ(56px)" }} />
              {/* Back */}
              <div className="absolute inset-0 border border-white/15 bg-white/[0.02]" style={{ transform: "rotateY(180deg) translateZ(56px)" }} />
              {/* Right */}
              <div className="absolute inset-0 border border-white/15 bg-white/[0.02]" style={{ transform: "rotateY(90deg) translateZ(56px)" }} />
              {/* Left */}
              <div className="absolute inset-0 border border-white/15 bg-white/[0.02]" style={{ transform: "rotateY(-90deg) translateZ(56px)" }} />
              {/* Top */}
              <div className="absolute inset-0 border border-white/15 bg-white/[0.02]" style={{ transform: "rotateX(90deg) translateZ(56px)" }} />
              {/* Bottom */}
              <div className="absolute inset-0 border border-white/15 bg-white/[0.02]" style={{ transform: "rotateX(-90deg) translateZ(56px)" }} />
            </div>
            {/* Inner cube for depth */}
            <div className="absolute inset-4 animate-[spin_12s_linear_infinite_reverse]" style={{ transformStyle: "preserve-3d" }}>
              <div className="absolute inset-0 border border-white/10" style={{ transform: "translateZ(28px)" }} />
              <div className="absolute inset-0 border border-white/10" style={{ transform: "rotateY(180deg) translateZ(28px)" }} />
              <div className="absolute inset-0 border border-white/10" style={{ transform: "rotateY(90deg) translateZ(28px)" }} />
              <div className="absolute inset-0 border border-white/10" style={{ transform: "rotateY(-90deg) translateZ(28px)" }} />
              <div className="absolute inset-0 border border-white/10" style={{ transform: "rotateX(90deg) translateZ(28px)" }} />
              <div className="absolute inset-0 border border-white/10" style={{ transform: "rotateX(-90deg) translateZ(28px)" }} />
            </div>
          </div>
        </div>

        <p className="mt-10 text-xs text-zinc-600">
          Explore rooms, join a session, or create your own.
        </p>

        <LandingActions />

        <div className="mt-12 grid w-full max-w-3xl grid-cols-1 gap-4 sm:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="group rounded-2xl border border-white/5 bg-white/[0.02] p-5 text-left transition-colors hover:border-white/10 hover:bg-white/[0.04]"
            >
              <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/5 text-zinc-400 transition-colors group-hover:text-white">
                {feature.icon}
              </div>
              <h3 className="mb-1 text-sm font-semibold text-white">
                {feature.title}
              </h3>
              <p className="text-xs leading-relaxed text-zinc-500">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
