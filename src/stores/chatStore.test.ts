import { describe, expect, it } from "vitest";
import { emptySlice, streamingIdsKey } from "./chatStore";

describe("streamingIdsKey", () => {
  it("names the conversations that are streaming, in a stable order", () => {
    const key = streamingIdsKey({
      b: { ...emptySlice(), isStreaming: true },
      a: { ...emptySlice(), isStreaming: true },
      c: { ...emptySlice(), isStreaming: false },
    });
    expect(key).toBe("a,b");
  });

  it("does not change when only streamed text changes, so the sidebar can skip the render", () => {
    const before = streamingIdsKey({ a: { ...emptySlice(), isStreaming: true, streamingContent: "Hel" } });
    const after = streamingIdsKey({ a: { ...emptySlice(), isStreaming: true, streamingContent: "Hello" } });
    expect(after).toBe(before);
  });

  it("is empty when nothing streams", () => {
    expect(streamingIdsKey({})).toBe("");
  });
});
