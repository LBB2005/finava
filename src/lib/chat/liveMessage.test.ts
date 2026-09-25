import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types/chat";
import { LIVE_ID, buildLiveMessage, committedDuringStream, handoffKeys, liveAnswerMode } from "./liveMessage";

const START = Date.parse("2026-09-24T10:00:00.000Z");
const msg = (id: string, role: ChatMessage["role"], at: number): ChatMessage => ({
  id,
  role,
  content: id,
  mode: "fast",
  createdAt: new Date(at).toISOString(),
});

describe("liveAnswerMode", () => {
  it("renders a crew run the way its committed message will be (agent / deep research)", () => {
    expect(liveAnswerMode("agent", 0)).toBe("agent");
    expect(liveAnswerMode("deep_research", 3)).toBe("deep_research");
    expect(liveAnswerMode("auto", 4)).toBe("agent");
  });

  it("renders Auto's fast answer and Quick mode as the fast lane", () => {
    expect(liveAnswerMode("auto", 0)).toBe("fast");
    expect(liveAnswerMode("simple", 0)).toBe("simple");
    expect(liveAnswerMode("fast", 0)).toBe("fast");
  });

  it("keeps discover as discover", () => {
    expect(liveAnswerMode("discover", 0)).toBe("discover");
  });
});

describe("buildLiveMessage", () => {
  it("is an assistant message stamped at the stream start, carrying the live crew", () => {
    const steps = [{ agent: "run_news_agent" as const, status: "complete" as const }];
    const m = buildLiveMessage({ content: "## Answer\nYes.", uiMode: "auto", steps, startedAt: START });
    expect(m).toMatchObject({ id: LIVE_ID, role: "assistant", content: "## Answer\nYes.", mode: "agent", agentTrace: steps });
    expect(m.createdAt).toBe(new Date(START).toISOString());
    expect(m.durationMs).toBeUndefined();
    expect(m.followups).toBeUndefined();
  });

  it("leaves agentTrace off when there is no crew", () => {
    expect(buildLiveMessage({ content: "x", uiMode: "fast", steps: [], startedAt: START }).agentTrace).toBeUndefined();
  });
});

describe("committedDuringStream", () => {
  it("is true once the answer this stream produced has been added to the list", () => {
    const list = [msg("q", "user", START - 5), msg("a", "assistant", START + 9000)];
    expect(committedDuringStream(list, START, "a")).toBe(true);
  });

  it("is false for an older answer or while the last message is the question", () => {
    expect(committedDuringStream([msg("a0", "assistant", START - 60_000)], START, "a0")).toBe(false);
    expect(committedDuringStream([msg("q", "user", START + 10)], START, "q")).toBe(false);
    expect(committedDuringStream([], START, "")).toBe(false);
    expect(committedDuringStream([msg("a", "assistant", START + 1)], null, "a")).toBe(false);
  });

  it("is false when the stream goes on after an earlier commit (Discover's shortlist, then the synthesis)", () => {
    const list = [msg("q", "user", START - 5), msg("shortlist", "assistant", START + 9000)];
    expect(committedDuringStream(list, START, "## Ranking the shortlist")).toBe(false);
  });
});

describe("handoffKeys", () => {
  it("gives the committed answer the live slot's key, so React keeps the same element", () => {
    const aliases = new Map<string, string>();
    const list = [msg("q", "user", START - 5), msg("a", "assistant", START + 9000)];
    const keys = handoffKeys(list, { liveKey: "live:1", liveContent: "a", streamStartedAt: START, aliases });
    expect(keys).toEqual(["q", "live:1"]);
    // It sticks after the stream is over.
    expect(handoffKeys(list, { liveKey: null, liveContent: "", streamStartedAt: START, aliases })).toEqual(["q", "live:1"]);
  });

  it("uses plain ids when nothing was handed off", () => {
    const list = [msg("q", "user", START - 5), msg("a0", "assistant", START - 1000)];
    expect(handoffKeys(list, { liveKey: "live:1", liveContent: "a0", streamStartedAt: START, aliases: new Map() })).toEqual(["q", "a0"]);
  });

  it("does not hand the live slot to a message that isn't the streamed text", () => {
    const list = [msg("q", "user", START - 5), msg("shortlist", "assistant", START + 9000)];
    const aliases = new Map<string, string>();
    expect(handoffKeys(list, { liveKey: "live:1", liveContent: "synthesis…", streamStartedAt: START, aliases })).toEqual(["q", "shortlist"]);
  });

  it("hands one live slot to one message only", () => {
    const aliases = new Map<string, string>();
    const list = [msg("a", "assistant", START + 9000)];
    handoffKeys(list, { liveKey: "live:1", liveContent: "a", streamStartedAt: START, aliases });
    const more = [...list, msg("b", "assistant", START + 9500)];
    expect(handoffKeys(more, { liveKey: "live:1", liveContent: "b", streamStartedAt: START, aliases })).toEqual(["live:1", "b"]);
  });
});
