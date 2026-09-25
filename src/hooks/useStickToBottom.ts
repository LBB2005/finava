"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  afterPin,
  initialFollow,
  isUpwardIntent,
  observeScroll,
  pinTarget,
  releaseFollow,
  resumeFollow,
  type FollowState,
  type ScrollMetrics,
} from "@/lib/chat/scrollFollow";

const metrics = (el: HTMLElement): ScrollMetrics => ({
  scrollTop: el.scrollTop,
  scrollHeight: el.scrollHeight,
  clientHeight: el.clientHeight,
});

/** Typing in the composer (ArrowUp in a textarea) is not a request to scroll. */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

/**
 * Keep a scroller pinned to the bottom while its content grows, but only while
 * the reader is there (see `scrollFollow.ts` for the rules).
 *
 * Growth is watched with a ResizeObserver on the content, not a render effect,
 * and every pin is batched into one animation frame: at most one scroll write
 * per frame, instant, never a stacked smooth-scroll.
 */
export function useStickToBottom(
  scrollerRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  o: {
    /** Start following again when this changes (a different conversation). */
    resetKey: unknown;
    /** The scroller is mounted (the list renders an empty state without one). */
    enabled: boolean;
  }
) {
  const { resetKey, enabled } = o;
  const state = useRef<FollowState>(initialFollow());
  const frame = useRef(0);
  const [following, setFollowing] = useState(true);
  /** Content grew below a reader who had scrolled up. */
  const [unseen, setUnseen] = useState(false);

  const commit = useCallback((next: FollowState) => {
    state.current = next;
    setFollowing(next.following);
    if (next.following) setUnseen(false);
  }, []);

  const pin = useCallback(() => {
    frame.current = 0;
    const el = scrollerRef.current;
    if (!el) return;
    // Look before moving: a reader's scroll that landed since the last pin wins.
    let s = observeScroll(state.current, metrics(el));
    const target = pinTarget(s, metrics(el));
    if (target != null) {
      el.scrollTop = target;
      s = afterPin(s, el.scrollTop);
    }
    commit(s);
  }, [scrollerRef, commit]);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(pin);
  }, [pin]);

  /** Resume following and go to the bottom ("Jump to latest", or the reader sent a message). */
  const follow = useCallback(() => {
    commit(resumeFollow(state.current));
    schedule();
  }, [commit, schedule]);

  // A different conversation starts at the bottom. The pin publishes the new
  // state (following, nothing unseen) from its frame callback.
  useEffect(() => {
    state.current = initialFollow();
    schedule();
  }, [resetKey, schedule]);

  useEffect(() => {
    const el = scrollerRef.current;
    const content = contentRef.current;
    if (!enabled || !el || !content) return;

    const release = () => {
      if (state.current.following) commit(releaseFollow(state.current));
    };
    const onScroll = () => commit(observeScroll(state.current, metrics(el)));
    const onWheel = (e: WheelEvent) => {
      if (isUpwardIntent({ kind: "wheel", deltaY: e.deltaY })) release();
    };
    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (touchY != null && y != null && isUpwardIntent({ kind: "touch", dy: y - touchY })) release();
      touchY = y ?? null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (!isTextEntry(e.target) && isUpwardIntent({ kind: "key", key: e.key })) release();
    };

    let lastHeight = content.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = content.offsetHeight;
      if (state.current.following) schedule();
      else if (h > lastHeight) setUnseen(true);
      lastHeight = h;
    });
    ro.observe(content);

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKey);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
    // The scroller only exists once there are messages; re-attach when it appears.
  }, [scrollerRef, contentRef, commit, schedule, resetKey, enabled]);

  return { following, unseen: !following && unseen, follow };
}
