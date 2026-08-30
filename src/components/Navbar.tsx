import Link from "next/link";

export function Navbar() {
  return (
    <header className="sticky top-0 z-30 px-4 pt-4 sm:px-6">
      <nav className="glass mx-auto flex h-14 max-w-6xl items-center justify-between rounded-2xl px-4 sm:px-5">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="relative flex h-7 w-7 items-center justify-center">
            <span className="absolute inset-0 rounded-full bg-accent/40 blur-md" />
            <span className="relative h-3.5 w-3.5 rounded-full bg-accent-soft shadow-[0_0_16px_rgba(196,181,253,0.7)]" />
          </span>
          <span className="text-[15px] font-medium tracking-tight text-white">
            Omnilume
          </span>
        </Link>

        <div className="hidden items-center gap-8 text-sm text-zinc-400 md:flex">
          <span className="cursor-default transition-colors hover:text-zinc-200">
            Rooms
          </span>
          <span className="cursor-default transition-colors hover:text-zinc-200">
            Watch
          </span>
          <span className="cursor-default transition-colors hover:text-zinc-200">
            Study
          </span>
        </div>

        <button
          type="button"
          className="rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-sm text-zinc-200 transition-colors hover:bg-white/10"
        >
          Sign in
        </button>
      </nav>
    </header>
  );
}
