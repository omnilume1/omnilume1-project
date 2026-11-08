import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./app-themes.css";
import GlobalFocusTrap from "@/components/GlobalFocusTrap";
import AmbientBackground from "@/components/ui/AmbientBackground";
import AppThemeSync from "@/components/ui/AppThemeSync";
import { THEME_BOOT_SCRIPT } from "@/lib/app-theme";
import GlassPointerLight from "@/components/ui/GlassPointerLight";
import OmniMarkSprite from "@/components/ui/OmniMarkSprite";
import AppProviders from "@/components/AppProviders";
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
      <head>
        {/* Sets the section and the saved theme before the first paint (see app-theme.ts). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-full bg-background font-sans text-foreground">
        <OmniMarkSprite />
        <AmbientBackground />
        <AppThemeSync />
        <GlassPointerLight />
        {/* Global Trap that enforces the URL redirect */}
        <GlobalFocusTrap />

        <AppProviders>{children}</AppProviders>

        {/* Agentation - development only */}
        {process.env.NODE_ENV === "development" && <DevAgentation />}
      </body>
    </html>
  );
}