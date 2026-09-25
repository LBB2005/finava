/**
 * Follow the stream only while the reader is at the bottom.
 *
 * The old rule re-pinned whenever the view was within 120 px of the bottom, on
 * every reveal frame, so a reader who scrolled up a little was pulled straight
 * back (45–64 times a second in the Session 1 bench). And one render that added
 * more than 120 px stopped following for good. This is a small state machine
 * instead: following is a decision the reader makes by scrolling, not a
 * distance the page re-measures.
 *
 * - Scrolling up at all releases, however close to the bottom.
 * - Reaching the bottom (or "Jump to latest") resumes.
 * - The pin checks where the view is before it moves it, so a reader's move that
 *   lands in the same frame as new text still wins.
 */

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface FollowState {
  following: boolean;
  /** scrollTop the last time we looked (after our own pin, if we pinned). */
  lastTop: number | null;
}

/** Within this of the bottom counts as "at the bottom" (sub-pixel scrollTop on HiDPI). */
export const AT_BOTTOM_PX = 2;
/** scrollTop jitter that is not a reader moving. */
const MOVE_EPSILON_PX = 1;

export function initialFollow(): FollowState {
  return { following: true, lastTop: null };
}

export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.clientHeight - m.scrollTop);
}

/** Fold in where the scroller is now. Run on every scroll event and just before each pin. */
export function observeScroll(s: FollowState, m: ScrollMetrics): FollowState {
  let following = s.following;
  if (distanceFromBottom(m) <= AT_BOTTOM_PX) following = true;
  // Moved up since we last looked, and not because the browser clamped a
  // shrinking transcript (that lands at the bottom, handled above).
  else if (s.lastTop != null && m.scrollTop < s.lastTop - MOVE_EPSILON_PX) following = false;

  if (following === s.following && m.scrollTop === s.lastTop) return s;
  return { following, lastTop: m.scrollTop };
}

/** Where scrollTop should go this frame, or null to leave the reader alone. */
export function pinTarget(s: FollowState, m: ScrollMetrics): number | null {
  if (!s.following) return null;
  if (distanceFromBottom(m) <= 0.5) return null;
  return m.scrollHeight - m.clientHeight;
}

/** Record our own pin so the next observation doesn't mistake it for the reader. */
export function afterPin(s: FollowState, top: number): FollowState {
  return { ...s, lastTop: top };
}

export function releaseFollow(s: FollowState): FollowState {
  return s.following ? { ...s, following: false } : s;
}

export function resumeFollow(s: FollowState): FollowState {
  return s.following ? s : { ...s, following: true };
}

export type ScrollIntent =
  | { kind: "wheel"; deltaY: number }
  /** Finger movement since the last touch event; positive = finger moved down. */
  | { kind: "touch"; dy: number }
  | { kind: "key"; key: string };

const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/**
 * Input that means "I want to read further up". Releasing on the input itself,
 * not only on the scroll it causes, means the next pin can't win the race.
 */
export function isUpwardIntent(e: ScrollIntent): boolean {
  if (e.kind === "wheel") return e.deltaY < 0;
  if (e.kind === "touch") return e.dy > 0;
  return UP_KEYS.has(e.key);
}
