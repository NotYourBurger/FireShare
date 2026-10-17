"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { layoutPoster, type PosterLine } from "./poster-layout";

const EASE_OUT_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1];
/** Seconds between one line's smear and the next, so the blur rolls down the stack. */
const WAVE_STEP = 0.7;

/** The tallest the type block may be, leaving room for the header, meta line and credit. */
function availableHeight(width: number): number {
  const vh = window.innerHeight;
  if (width < 640) return Math.max(220, vh * 0.42);
  return Math.max(260, Math.min(vh - 340, 640));
}

/**
 * Sets the quote on a canvas measurement of the display face, then lays it
 * out again whenever the column changes width.
 */
function usePosterLayout(quote: string) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ quote: string; lines: PosterLine[] } | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let cancelled = false;
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;

    const run = async () => {
      const family = getComputedStyle(stage).fontFamily;
      context.font = `400 100px ${family}`;
      try {
        await document.fonts.load(context.font, quote);
      } catch {
        // Fall back to whatever face is available.
      }
      if (cancelled) return;
      context.font = `400 100px ${family}`;
      const width = stage.clientWidth;
      const lines = layoutPoster({
        text: quote,
        measure: (text) => context.measureText(text).width,
        width,
        maxHeight: availableHeight(width),
      });
      setLayout({ quote, lines });
    };

    void run();
    const observer = new ResizeObserver(() => void run());
    observer.observe(stage);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [quote]);

  return { stageRef, lines: layout?.quote === quote ? layout.lines : null };
}

/**
 * The quote set as a poster: every line sized to run the full width, each
 * settling out of a vertical motion blur, then a slow smear that rolls down
 * the stack one line at a time.
 */
export function KineticQuote({
  quote,
  author,
  label,
  studyId,
}: {
  quote: string;
  author: string;
  label: string;
  studyId: string;
}) {
  const { stageRef, lines } = usePosterLayout(quote);
  const count = lines?.length ?? 0;

  return (
    <div className="poster-stage" ref={stageRef}>
      <p className="visually-hidden">
        {quote} — {author}
      </p>
      <AnimatePresence mode="wait">
        {lines && (
          <motion.figure
            key={`${studyId}-${quote}`}
            className="poster"
            aria-hidden="true"
            initial="hidden"
            animate="visible"
            exit="exit"
            style={{ "--wave": `${Math.max(count * WAVE_STEP + 4, 9)}s` } as React.CSSProperties}
          >
            <motion.div
              className="poster-meta"
              variants={{
                hidden: { opacity: 0, y: 6 },
                visible: { opacity: 1, y: 0, transition: { duration: 1.2, ease: EASE_OUT_EXPO } },
                exit: { opacity: 0, transition: { duration: 0.4 } },
              }}
            >
              <span>Ephemeral transfer</span>
              <span className="poster-meta-rule" />
              <span>{label}</span>
              <span className="poster-meta-rule" />
              <span>No. {studyId}</span>
            </motion.div>

            <div className="poster-lines">
              {lines.map((line, i) => (
                <span
                  key={`${i}-${line.text}`}
                  className="poster-line"
                  data-align={line.align}
                  style={{ fontSize: `${line.size}px`, "--i": i } as React.CSSProperties}
                >
                  <motion.span
                    className="poster-line-inner"
                    custom={i}
                    variants={{
                      hidden: { opacity: 0, y: "-0.28em", scaleY: 1.55, filter: "blur(0.12em)" },
                      visible: (n: number) => ({
                        opacity: 1,
                        y: "0em",
                        scaleY: 1,
                        filter: "blur(0em)",
                        transition: { duration: 1.5, delay: 0.1 + n * 0.11, ease: EASE_OUT_EXPO },
                      }),
                      exit: (n: number) => ({
                        opacity: 0,
                        y: "0.2em",
                        scaleY: 1.35,
                        filter: "blur(0.1em)",
                        transition: { duration: 0.55, delay: n * 0.05, ease: [0.4, 0, 1, 1] },
                      }),
                    }}
                  >
                    <span className="poster-line-text">{line.text}</span>
                    <span className="poster-line-ghost">{line.text}</span>
                  </motion.span>
                </span>
              ))}
            </div>

            <motion.figcaption
              className="poster-credit"
              variants={{
                hidden: { opacity: 0, y: 6 },
                visible: {
                  opacity: 1,
                  y: 0,
                  transition: { duration: 1.2, delay: 0.3 + count * 0.11, ease: EASE_OUT_EXPO },
                },
                exit: { opacity: 0, transition: { duration: 0.4 } },
              }}
            >
              <small>Words by</small>
              <span>{author}</span>
            </motion.figcaption>
          </motion.figure>
        )}
      </AnimatePresence>
    </div>
  );
}
