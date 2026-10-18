"use client";

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { KineticQuote } from "./kinetic-typography";
import { EDITORIAL_BACKDROPS, type EditorialBackdrop, type Quote } from "./quote";

const THEME_STORAGE_KEY = "fireshare.theme";
const AUTO_CYCLE_MS = 14000;
const EASE_OUT_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1];

export function EditorialShell({
  initialQuote,
  initialBackdrop,
  children,
}: {
  initialQuote: Quote;
  initialBackdrop: EditorialBackdrop;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [quote, setQuote] = useState<Quote>(initialQuote);
  const [backdrop, setBackdrop] = useState<EditorialBackdrop>(initialBackdrop);
  const [refreshing, setRefreshing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === "light" || saved === "dark") {
        setTheme(saved);
        document.documentElement.dataset.theme = saved;
        return;
      }
    } catch {
      // Ignore storage access errors in restricted contexts.
    }
    const prefersDark =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = prefersDark ? "dark" : "light";
    setTheme(resolved);
    document.documentElement.dataset.theme = resolved;
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore storage errors.
    }
  }

  const nextBackdrop = useCallback(() => {
    const currentIdx = EDITORIAL_BACKDROPS.findIndex((b) => b.id === backdrop.id);
    return EDITORIAL_BACKDROPS[(currentIdx + 1) % EDITORIAL_BACKDROPS.length];
  }, [backdrop.id]);

  const refreshInspiration = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/quote", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { quote?: Quote; backdrop?: EditorialBackdrop };
        if (data.quote) setQuote(data.quote);
        // Always move to a different photo, even if random returned the same one.
        setBackdrop(data.backdrop && data.backdrop.id !== backdrop.id ? data.backdrop : nextBackdrop());
      }
    } catch {
      // Offline: keep the quote, still turn the photo.
      setBackdrop(nextBackdrop());
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, backdrop.id, nextBackdrop]);

  // Slowly turn the photo and quote while the page is visible.
  useEffect(() => {
    if (paused) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshInspiration();
    }, AUTO_CYCLE_MS);
    return () => window.clearInterval(timer);
  }, [paused, refreshInspiration]);

  const isRecent = pathname?.startsWith("/recent");

  return (
    <MotionConfig reducedMotion="user">
      <div className="ambient-app">
        <div className="ambient-noise" aria-hidden="true" />

        {/* One monochrome photograph behind the whole page, fading out through the middle. */}
        <div className="scene" aria-hidden="true">
          <AnimatePresence mode="sync">
            <motion.div
              key={backdrop.id}
              className="scene-photo"
              initial={{ opacity: 0, filter: "blur(18px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(10px)" }}
              transition={{ duration: 2.4, ease: EASE_OUT_EXPO }}
            >
              <div
                className="scene-photo-image"
                style={{
                  backgroundImage: `url("${backdrop.localPhotoUrl}"), ${backdrop.fallbackGradient}`,
                }}
              />
            </motion.div>
          </AnimatePresence>
          <motion.div
            className="scene-overlay"
            animate={{
              backgroundPosition: ["0% 0%", "100% 100%", "0% 50%", "0% 0%"],
              opacity: [0.85, 1, 0.9, 0.85],
            }}
            transition={{ duration: 24, repeat: Infinity, ease: "easeInOut" }}
          />
          <div className="scene-veil" />
          <div className="scene-grain" />
        </div>

        <motion.header
          className="ambient-header"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1.2, ease: EASE_OUT_EXPO }}
        >
          <a href="/" className="brand-cluster" aria-label="FireShare home">
            <span className="brand-dot" aria-hidden="true" />
            <span className="brand-name">FIRESHARE</span>
          </a>

          <nav className="ambient-nav" aria-label="Primary">
            <a href="/" className={`nav-pill ${!isRecent ? "active" : ""}`}>
              Transfer
            </a>
            <a href="/recent" className={`nav-pill ${isRecent ? "active" : ""}`}>
              Recent
            </a>
            <button
              type="button"
              className="theme-toggle"
              onClick={toggleTheme}
              aria-label={mounted ? `Switch to ${theme === "dark" ? "light" : "dark"} theme` : "Toggle color theme"}
              title={mounted ? `Switch to ${theme === "dark" ? "light" : "dark"} theme` : "Toggle theme"}
            >
              <span className="theme-indicator" aria-hidden="true" />
              <span>{mounted ? (theme === "dark" ? "Obsidian" : "Alabaster") : "Theme"}</span>
            </button>
          </nav>
        </motion.header>

        <div className="editorial-stage">
          <aside
            className="visual-showcase"
            aria-label="Quote"
            onPointerEnter={() => setPaused(true)}
            onPointerLeave={() => setPaused(false)}
          >
            <KineticQuote quote={quote.quote} author={quote.author} label={backdrop.label} studyId={backdrop.id} />
          </aside>

          <motion.section
            className="workspace-panel"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1.1, delay: 0.15, ease: EASE_OUT_EXPO }}
          >
            {children}
          </motion.section>
        </div>
      </div>
    </MotionConfig>
  );
}
