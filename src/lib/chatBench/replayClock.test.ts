import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayClock } from "./replayClock";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const clock = (speed = 1) => new ReplayClock({ speed, now: () => Date.now() });

describe("ReplayClock", () => {
  it("stands still until play, then runs at the chosen speed", () => {
    const c = clock(4);
    vi.advanceTimersByTime(500);
    expect(c.elapsed()).toBe(0);
    c.play();
    vi.advanceTimersByTime(500);
    expect(c.elapsed()).toBe(2_000);
  });

  it("pause freezes the replay and play carries on from the same point", () => {
    const c = clock();
    c.play();
    vi.advanceTimersByTime(300);
    c.pause();
    vi.advanceTimersByTime(10_000);
    expect(c.elapsed()).toBe(300);
    expect(c.paused).toBe(true);
    c.play();
    vi.advanceTimersByTime(200);
    expect(c.elapsed()).toBe(500);
  });

  it("a speed change keeps the replay position and changes only the pace", () => {
    const c = clock(1);
    c.play();
    vi.advanceTimersByTime(1_000);
    c.setSpeed(4);
    expect(c.elapsed()).toBe(1_000);
    vi.advanceTimersByTime(1_000);
    expect(c.elapsed()).toBe(5_000);
  });

  it("sleepUntil wakes when replay time reaches the target, scaled by speed", async () => {
    const c = clock(4);
    c.play();
    let woke = false;
    void c.sleepUntil(4_000).then(() => (woke = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(woke).toBe(true);
  });

  it("sleepUntil does not wake while paused, and resumes with the clock", async () => {
    const c = clock();
    c.play();
    let woke = false;
    void c.sleepUntil(1_000).then(() => (woke = true));
    await vi.advanceTimersByTimeAsync(400);
    c.pause();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(woke).toBe(false);
    c.play();
    await vi.advanceTimersByTimeAsync(599);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(woke).toBe(true);
  });

  it("sleepUntil picks up a speed change made while it waits", async () => {
    const c = clock(1);
    c.play();
    let woke = false;
    void c.sleepUntil(8_000).then(() => (woke = true));
    await vi.advanceTimersByTimeAsync(4_000);
    c.setSpeed(4);
    await vi.advanceTimersByTimeAsync(999);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(woke).toBe(true);
  });

  it("sleepUntil rejects with an AbortError when the signal aborts", async () => {
    const c = clock();
    c.play();
    const ctrl = new AbortController();
    const p = c.sleepUntil(10_000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("sleepUntil for a time already passed still wakes in a new task, like a network chunk", async () => {
    // Overdue chunks resolved in one microtask chain would never let the page
    // render between them: one giant long task that a real network never makes.
    const c = clock();
    c.play();
    vi.advanceTimersByTime(100);
    let woke = false;
    void c.sleepUntil(50).then(() => (woke = true));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(woke).toBe(true);
  });
});
