import { LandingActions } from "@/components/LandingActions";
import { Navbar } from "@/components/Navbar";

export default function Home() {
  return (
    <div className="ambient flex min-h-full flex-col">
      <Navbar />

      <main className="relative mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center px-6 pb-24 pt-16 text-center">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-400">
          <span className="h-1.5 w-1.5 rounded-full bg-accent-soft" />
          Shared digital spaces
        </div>

        <h1 className="max-w-2xl text-4xl font-medium tracking-tight text-white sm:text-6xl sm:leading-[1.08]">
          Watch, study, and talk in one calm room.
        </h1>

        <p className="mt-5 max-w-lg text-base leading-7 text-zinc-400 sm:text-lg">
          Create a room, invite people with a code, and keep chat, media, and
          tools together. This is the local visual foundation.
        </p>

        <LandingActions />
      </main>
    </div>
  );
}
