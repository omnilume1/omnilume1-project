import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./management.css";
import GlobalFocusTrap from "@/components/GlobalFocusTrap";
import AmbientBackground from "@/components/ui/AmbientBackground";
import GlassPointerLight from "@/components/ui/GlassPointerLight";
import OmniMarkSprite from "@/components/ui/OmniMarkSprite";
import GlobalMiniPlayer from "@/components/music/GlobalMiniPlayer";
import { ListenTogetherProvider } from "@/hooks/useListenTogether";
import { MusicPlayerProvider } from "@/hooks/useMusicPlayer";
import DevAgentation from "@/components/DevAgentation";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Omnilume",
  description:
    "Shared digital spaces for watching, studying, and talking together.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      // The landing's once-per-session intro script sets data-intro-seen before hydration.
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full bg-background font-sans text-foreground">
        <OmniMarkSprite />
        <AmbientBackground />
        <GlassPointerLight />
        {/* Global Trap that enforces the URL redirect */}
        <GlobalFocusTrap />

        <MusicPlayerProvider>
          <ListenTogetherProvider>
            {children}
            <GlobalMiniPlayer />
          </ListenTogetherProvider>
        </MusicPlayerProvider>

        {/* Agentation - development only */}
        {process.env.NODE_ENV === "development" && <DevAgentation />}
      </body>
    </html>
  );
}