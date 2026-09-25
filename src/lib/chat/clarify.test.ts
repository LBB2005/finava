import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types/chat";
import {
  cleanClarify,
  foldClarification,
  pendingClarifyOf,
  questionsText,
  receiptText,
  replyContent,
  MAX_CLARIFY_OPTIONS,
  MAX_CLARIFY_QUESTIONS,
  type ClarifyQuestion,
  type ClarifyReply,
} from "./clarify";

const horizon: ClarifyQuestion = {
  header: "Horizon",
  question: "What's your time horizon?",
  options: [
    { label: "Long term", description: "3+ years, compounders" },
    { label: "Swing", description: "Weeks to months, momentum" },
  ],
};

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: crypto.randomUUID(),
  role: "user",
  content: "",
  mode: "auto",
  createdAt: "2026-09-25T00:00:00.000Z",
  ...over,
});

describe("cleanClarify", () => {
  it("keeps a well-formed question set", () => {
    expect(cleanClarify([horizon])).toEqual([horizon]);
  });

  it("returns null for anything unusable", () => {
    expect(cleanClarify(null)).toBeNull();
    expect(cleanClarify("what?")).toBeNull();
    expect(cleanClarify([])).toBeNull();
    expect(cleanClarify([{ question: "Which?", options: [] }])).toBeNull();
    expect(cleanClarify([{ question: "", options: ["a", "b"] }])).toBeNull();
  });

  it("caps questions and options", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      header: `Q${i}`,
      question: `Question ${i}?`,
      options: ["a", "b", "c", "d", "e", "f"],
    }));
    const out = cleanClarify(many)!;
    expect(out).toHaveLength(MAX_CLARIFY_QUESTIONS);
    expect(out[0].options).toHaveLength(MAX_CLARIFY_OPTIONS);
  });

  it("drops a question left with fewer than two options", () => {
    const out = cleanClarify([{ question: "One?", options: ["only"] }, horizon])!;
    expect(out).toEqual([horizon]);
  });

  it("accepts plain-string options, trims, dedupes and drops 'Other' (the panel adds its own)", () => {
    const out = cleanClarify([
      { header: " Style ", question: " What are you after? ", options: [" Growth ", "growth", "Value", "Other", "Other…"] },
    ])!;
    expect(out[0]).toEqual({
      header: "Style",
      question: "What are you after?",
      options: [{ label: "Growth" }, { label: "Value" }],
    });
  });

  it("fills a missing header and shortens a long one", () => {
    const out = cleanClarify([
      { question: "A?", options: ["x", "y"] },
      { header: "A very long header indeed", question: "B?", options: ["x", "y"] },
    ])!;
    expect(out[0].header).toBe("Question 1");
    expect(out[1].header.length).toBeLessThanOrEqual(16);
  });

  it("drops an empty description", () => {
    const out = cleanClarify([{ question: "A?", options: [{ label: "x", description: "  " }, { label: "y" }] }])!;
    expect(out[0].options[0]).toEqual({ label: "x" });
  });

  it("reads the legacy single-question shape", () => {
    const out = cleanClarify({ clarifyQuestion: "What are you optimising for?", clarifyChips: ["Growth", "Income"] })!;
    expect(out).toEqual([
      { header: "Focus", question: "What are you optimising for?", options: [{ label: "Growth" }, { label: "Income" }] },
    ]);
  });

  it("reads a { clarify: [...] } wrapper", () => {
    expect(cleanClarify({ clarify: [horizon] })).toEqual([horizon]);
  });
});

describe("pendingClarifyOf", () => {
  it("is null when the conversation doesn't end on a question", () => {
    expect(pendingClarifyOf([])).toBeNull();
    expect(pendingClarifyOf([msg({ content: "hi" })])).toBeNull();
    expect(pendingClarifyOf([msg({ content: "hi" }), msg({ role: "assistant", content: "hello", mode: "fast" })])).toBeNull();
  });

  it("is null once the question has been answered", () => {
    const messages = [
      msg({ content: "what should I buy?" }),
      msg({ role: "assistant", content: "What's your time horizon?", mode: "fast", clarify: [horizon] }),
      msg({ content: "Long term", clarifyReply: { answers: [], skipped: true } }),
    ];
    expect(pendingClarifyOf(messages)).toBeNull();
  });

  it("returns the questions, the prompt they're about and its mode", () => {
    const ask = msg({ role: "assistant", content: "What's your time horizon?", mode: "fast", clarify: [horizon] });
    const p = pendingClarifyOf([msg({ content: "earlier" }), msg({ role: "assistant", content: "ok" }), msg({ content: "what should I buy?", mode: "discover" }), ask]);
    expect(p).toEqual({ messageId: ask.id, questions: [horizon], originalPrompt: "what should I buy?", mode: "discover" });
  });

  it("falls back to auto when no user prompt precedes the question", () => {
    const p = pendingClarifyOf([msg({ role: "assistant", content: "?", clarify: [horizon] })]);
    expect(p?.originalPrompt).toBe("");
    expect(p?.mode).toBe("auto");
  });
});

const answered: ClarifyReply = {
  skipped: false,
  answers: [
    { header: "Horizon", question: "What's your time horizon?", answer: "Long term" },
    { header: "Amount", question: "Roughly how much?", answer: "$1k–$10k" },
  ],
};
const skipped: ClarifyReply = { skipped: true, answers: [] };

describe("foldClarification", () => {
  it("appends each answer to the original prompt", () => {
    expect(foldClarification("what should I buy?", answered)).toBe(
      "what should I buy?\n\n[User clarification]:\n- What's your time horizon? Long term\n- Roughly how much? $1k–$10k"
    );
  });

  it("tells the lane to answer with stated assumptions on a skip", () => {
    const out = foldClarification("what should I buy?", skipped);
    expect(out.startsWith("what should I buy?\n\n")).toBe(true);
    expect(out).toMatch(/skipped/i);
    expect(out).toMatch(/assum/i);
  });

  it("treats an empty answer list as a skip", () => {
    expect(foldClarification("x", { skipped: false, answers: [] })).toBe(foldClarification("x", skipped));
  });
});

describe("reply text", () => {
  it("replyContent is readable history text", () => {
    expect(replyContent(answered)).toBe("Horizon: Long term\nAmount: $1k–$10k");
    expect(replyContent(skipped)).toBe("Skipped the questions.");
  });

  it("receiptText is the one-line receipt", () => {
    expect(receiptText(answered)).toBe("Horizon: Long term · Amount: $1k–$10k");
    expect(receiptText(skipped)).toBe("Skipped — answered with assumptions");
  });

  it("questionsText is the question the transcript keeps", () => {
    expect(questionsText([horizon])).toBe("What's your time horizon?");
    expect(questionsText([horizon, { ...horizon, question: "How much?" }])).toBe("What's your time horizon?\nHow much?");
  });
});
