import { describe, expect, it } from "vitest";
import {
  AT_BOTTOM_PX,
  afterPin,
  distanceFromBottom,
  initialFollow,
  isUpwardIntent,
  observeScroll,
  pinTarget,
  releaseFollow,
  resumeFollow,
  type FollowState,
  type ScrollMetrics,
} from "./scrollFollow";

const VIEW = 800;
const at = (scrollTop: number, scrollHeight: number): ScrollMetrics => ({ scrollTop, scrollHeight, clientHeight: VIEW });
const bottomOf = (scrollHeight: number) => at(scrollHeight - VIEW, scrollHeight);

/** Pin the way the hook does: observe, then move to the target if there is one. */
function frame(s: FollowState, m: ScrollMetrics): { s: FollowState; top: number } {
  const seen = observeScroll(s, m);
  const target = pinTarget(seen, m);
  if (target == null) return { s: seen, top: m.scrollTop };
  return { s: afterPin(seen, target), top: target };
}

describe("distanceFromBottom", () => {
  it("is zero at the bottom and never negative", () => {
    expect(distanceFromBottom(bottomOf(2000))).toBe(0);
    expect(distanceFromBottom(at(1300, 2000))).toBe(0); // overscroll clamps to 0
    expect(distanceFromBottom(at(0, 2000))).toBe(1200);
  });
});

describe("following the stream", () => {
  it("starts out following and pins a fresh transcript to the bottom", () => {
    const s = initialFollow();
    expect(s.following).toBe(true);
    expect(pinTarget(observeScroll(s, at(0, 3000)), at(0, 3000))).toBe(2200);
  });

  it("keeps pinning as the answer grows, one target per frame", () => {
    let s = initialFollow();
    let top = 0;
    for (let h = 1000; h <= 4000; h += 37) {
      const r = frame(s, at(top, h));
      s = r.s;
      top = r.top;
      expect(top).toBe(h - VIEW);
      expect(s.following).toBe(true);
    }
  });

  it("does nothing when already at the bottom", () => {
    const s = afterPin(initialFollow(), 1200);
    expect(pinTarget(observeScroll(s, bottomOf(2000)), bottomOf(2000))).toBeNull();
  });
});

describe("releasing when the reader scrolls up", () => {
  it("releases on the first small step up, even 5 px from the bottom", () => {
    // Pinned at the bottom of a 2000 px transcript…
    let s = afterPin(initialFollow(), 1200);
    // …the reader nudges up 5 px (a trackpad frame).
    s = observeScroll(s, at(1195, 2000));
    expect(s.following).toBe(false);
  });

  it("never yanks a reader who scrolled up, however much the answer grows", () => {
    let s = afterPin(initialFollow(), 1200);
    let top = 1195; // reader stepped up
    let h = 2000;
    for (let i = 0; i < 60; i++) {
      h += 25; // answer keeps growing
      top -= 5; // reader keeps reading upward
      const r = frame(s, at(top, h));
      s = r.s;
      expect(r.top).toBe(top); // untouched
      expect(s.following).toBe(false);
    }
  });

  it("releases when the reader's move landed in the same frame as growth (the pin sees it first)", () => {
    // The pin put us at 1200; before the next pin the reader moved to 1190 and the
    // answer grew by 60 px. The pin must notice the move rather than overwrite it.
    const s = afterPin(initialFollow(), 1200);
    const r = frame(s, at(1190, 2060));
    expect(r.s.following).toBe(false);
    expect(r.top).toBe(1190);
  });

  it("keeps following when content above shrinks and the browser clamps scrollTop", () => {
    // Pinned at 1200 of 2000; the panel above collapses by 150 px → the browser
    // clamps scrollTop to the new max. That is not the reader moving.
    const s = afterPin(initialFollow(), 1200);
    const seen = observeScroll(s, at(1050, 1850));
    expect(seen.following).toBe(true);
  });

  it("treats wheel-up, touch-drag-down and paging keys as intent to read up", () => {
    expect(isUpwardIntent({ kind: "wheel", deltaY: -40 })).toBe(true);
    expect(isUpwardIntent({ kind: "wheel", deltaY: 40 })).toBe(false);
    expect(isUpwardIntent({ kind: "touch", dy: 12 })).toBe(true); // finger moves down = content up
    expect(isUpwardIntent({ kind: "touch", dy: -12 })).toBe(false);
    expect(isUpwardIntent({ kind: "key", key: "PageUp" })).toBe(true);
    expect(isUpwardIntent({ kind: "key", key: "ArrowUp" })).toBe(true);
    expect(isUpwardIntent({ kind: "key", key: "Home" })).toBe(true);
    expect(isUpwardIntent({ kind: "key", key: "a" })).toBe(false);
    expect(releaseFollow(initialFollow()).following).toBe(false);
  });
});

describe("resuming", () => {
  it("resumes when the reader scrolls back down to the bottom", () => {
    let s = releaseFollow(afterPin(initialFollow(), 1200));
    s = observeScroll(s, at(1100, 2000));
    expect(s.following).toBe(false);
    s = observeScroll(s, at(1200 - AT_BOTTOM_PX, 2000));
    expect(s.following).toBe(true);
  });

  it("does not resume just because the reader scrolled down part of the way", () => {
    let s = releaseFollow(afterPin(initialFollow(), 1200));
    s = observeScroll(s, at(900, 2000));
    s = observeScroll(s, at(1100, 2000));
    expect(s.following).toBe(false);
  });

  it("resumes on Jump to latest and pins on the next frame", () => {
    const released = releaseFollow(observeScroll(afterPin(initialFollow(), 1200), at(700, 2000)));
    const s = resumeFollow(released);
    expect(s.following).toBe(true);
    const r = frame(s, at(700, 2400));
    expect(r.top).toBe(1600);
    expect(r.s.following).toBe(true);
  });

  it("returns the same object when nothing changed, so React can skip a render", () => {
    const s = observeScroll(afterPin(initialFollow(), 1200), bottomOf(2000));
    expect(observeScroll(s, bottomOf(2000))).toBe(s);
  });
});
