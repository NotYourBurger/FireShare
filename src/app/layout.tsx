import type { Metadata } from "next";
import { Anton, Geist } from "next/font/google";
import { EditorialShell } from "./editorial-shell";
import "./globals.css";
import { currentQuote } from "./current-quote";
import { pickRandomBackdrop } from "./quote";

// Downloaded at build time and served by the app.
const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const anton = Anton({ subsets: ["latin"], weight: "400", variable: "--font-display" });

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "FireShare",
  description: "Self-hosted temporary file sharing",
  referrer: "no-referrer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const quote = currentQuote();
  const backdrop = pickRandomBackdrop();
  return (
    <html lang="en" className={`${geist.variable} ${anton.variable}`} suppressHydrationWarning>
      <body>
        <EditorialShell initialQuote={quote} initialBackdrop={backdrop}>
          {children}
        </EditorialShell>
      </body>
    </html>
  );
}
