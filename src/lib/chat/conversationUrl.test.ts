import { describe, expect, it } from "vitest";
import { chatHref, onStoreConversationChange, onUrlConversationChange } from "./conversationUrl";

describe("chatHref", () => {
  it("puts the id in ?c=", () => {
    expect(chatHref("abc-123")).toBe("/chat?c=abc-123");
    expect(chatHref(null)).toBe("/chat");
  });
});

describe("onUrlConversationChange (reload, back/forward, pasted link)", () => {
  it("opens the conversation named by the URL", () => {
    expect(onUrlConversationChange("a", null)).toEqual({ kind: "open", id: "a" });
    expect(onUrlConversationChange("b", "a")).toEqual({ kind: "open", id: "b" });
  });
  it("clears the view when the URL has no id but the store does", () => {
    expect(onUrlConversationChange(null, "a")).toEqual({ kind: "clear" });
  });
  it("does nothing when already in sync", () => {
    expect(onUrlConversationChange("a", "a")).toEqual({ kind: "none" });
    expect(onUrlConversationChange(null, null)).toEqual({ kind: "none" });
  });
});

describe("onStoreConversationChange (new chat, opened from sidebar)", () => {
  it("replaces a bare /chat with the new id, so back doesn't land on an empty chat", () => {
    expect(onStoreConversationChange("new", null)).toEqual({ kind: "write", href: "/chat?c=new", replace: true });
  });
  it("pushes when switching between conversations, so back returns to the previous one", () => {
    expect(onStoreConversationChange("b", "a")).toEqual({ kind: "write", href: "/chat?c=b", replace: false });
  });
  it("pushes a bare /chat when the view is reset to a new chat", () => {
    expect(onStoreConversationChange(null, "a")).toEqual({ kind: "write", href: "/chat", replace: false });
  });
  it("does nothing when already in sync", () => {
    expect(onStoreConversationChange("a", "a")).toEqual({ kind: "none" });
  });
});
