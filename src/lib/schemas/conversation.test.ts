import { describe, expect, it } from "vitest";
import { AddMessageSchema } from "./conversation";

const clarify = [{ header: "Horizon", question: "What's your time horizon?", options: [{ label: "Long term", description: "3+ years" }, { label: "Swing" }] }];

describe("AddMessageSchema — clarify fields", () => {
  it("accepts a question set and a reply", () => {
    expect(AddMessageSchema.safeParse({ role: "assistant", content: "?", clarify }).success).toBe(true);
    expect(
      AddMessageSchema.safeParse({
        role: "user",
        content: "Horizon: Long term",
        clarifyReply: { skipped: false, answers: [{ header: "Horizon", question: "What's your time horizon?", answer: "Long term" }] },
      }).success
    ).toBe(true);
  });

  it("rejects more than three questions or four options", () => {
    const q = clarify[0];
    expect(AddMessageSchema.safeParse({ role: "assistant", content: "?", clarify: [q, q, q, q] }).success).toBe(false);
    const wide = { ...q, options: ["a", "b", "c", "d", "e"].map((label) => ({ label })) };
    expect(AddMessageSchema.safeParse({ role: "assistant", content: "?", clarify: [wide] }).success).toBe(false);
  });

  it("rejects an oversized free-text answer", () => {
    const answers = [{ header: "H", question: "Q?", answer: "x".repeat(2001) }];
    expect(AddMessageSchema.safeParse({ role: "user", content: "x", clarifyReply: { skipped: false, answers } }).success).toBe(false);
  });
});
