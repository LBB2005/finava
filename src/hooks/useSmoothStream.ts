"use client";
import { useEffect, useRef, useState } from "react";
import { REVEAL_FRAME_MS, revealStep } from "@/lib/chat/revealPace";

/**
 * The streamed answer, revealed at a steady pace instead of in SSE bursts.
 * Updates at most ~30 times a second and on word ends (`revealStep`), so the
 * answer re-renders half as often as it did on every animation frame.
 */
export function useSmoothStream(raw: string, active: boolean): string {
  const [display, setDisplay] = useState(raw);
  const rawRef = useRef(raw);
  const shownRef = useRef(active ? 0 : raw.length);

  useEffect(() => {
    rawRef.current = raw;
    if (!active) shownRef.current = raw.length;
  }, [raw, active]);

  useEffect(() => {
    if (!active) {
      shownRef.current = rawRef.current.length;
      setDisplay(rawRef.current);
      return;
    }
    let frame = 0;
    let last = 0;
    let pending = 0;
    const loop = (t: number) => {
      if (!last) last = t;
      pending += t - last;
      last = t;
      if (pending >= REVEAL_FRAME_MS) {
        const text = rawRef.current;
        const next = revealStep(text, shownRef.current, pending);
        pending = 0;
        if (next !== shownRef.current) {
          shownRef.current = next;
          setDisplay(text.slice(0, next));
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return active ? display : raw;
}
