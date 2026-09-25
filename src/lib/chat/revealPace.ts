/**
 * How much of the streamed answer to show next.
 *
 * SSE arrives in bursts; the reveal smooths it out. It used to advance on every
 * animation frame, and every advance re-rendered the answer. Now it advances at
 * most ~30 times a second and lands on word ends, which is all the eye needs,
 * and it halves the render work.
 */

/** Minimum time between reveal updates (~30 fps). */
export const REVEAL_FRAME_MS = 33;

/** Base pace on a short backlog; the reveal speeds up as the backlog grows. */
const BASE_CPS = 110;
const CATCH_UP_PER_CHAR = 6;
/** Look this far ahead for the end of the current word before giving up (a URL). */
const WORD_SNAP_CHARS = 16;

/** The next reveal index after `dtMs`, given `shown` characters are on screen. */
export function revealStep(text: string, shown: number, dtMs: number): number {
  // A new stream replaced the text: start again from the top.
  if (shown > text.length) shown = 0;
  const backlog = text.length - shown;
  if (backlog <= 0) return shown;

  const cps = Math.max(BASE_CPS, backlog * CATCH_UP_PER_CHAR);
  let next = shown + Math.min(backlog, Math.max(1, Math.round((cps * dtMs) / 1000)));
  if (next >= text.length) return text.length;

  // Finish the word we're in. The end of the buffer counts as a word end: the
  // rest may not arrive until after a long pause.
  if (!/\s/.test(text[next])) {
    const limit = Math.min(text.length, next + WORD_SNAP_CHARS);
    let j = next;
    while (j < limit && !/\s/.test(text[j])) j++;
    if (j < limit || limit === text.length) next = j;
  }
  return next;
}
