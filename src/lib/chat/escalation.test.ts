import { describe, expect, it } from "vitest";
import { fullAnalysisPrompt } from "./escalation";

describe("fullAnalysisPrompt", () => {
  it("keeps the user's question as the subject of the run", () => {
    expect(fullAnalysisPrompt("Is AMD a buy at today's price?")).toContain("Is AMD a buy at today's price?");
  });

  it("tells the crew this is an escalation, so it does the work instead of recapping", () => {
    // Pressing the button re-asks a question the fast lane just answered, and
    // that answer is in the transcript. Without this the CEO reads its own
    // recent answer and replies "I already ran a full analysis … here's a recap",
    // running zero agents — the opposite of what the button promises.
    const p = fullAnalysisPrompt("What about MSFT at this price?").toLowerCase();
    expect(p).toContain("full");
    expect(p).toMatch(/do not (summarise|summarize)|don't summarise|rather than summaris/);
    expect(p).toMatch(/previous|earlier|short answer/);
  });

  it("is empty for an empty question, so no run starts", () => {
    expect(fullAnalysisPrompt("   ")).toBe("");
  });
});
