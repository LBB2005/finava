import { describe, expect, it } from "vitest";
import {
  hasSubject,
  isReuseFollowUp,
  resolveIntent,
  wantsFullAnalysis,
  type Intent,
} from "./intent";

describe("wantsFullAnalysis", () => {
  const explicit = [
    "full analysis of NVDA",
    "Give me a FULL ANALYSIS on AMD please",
    "do a deep dive on TSLA",
    "run the crew on MSFT",
    "deploy the agents on PLTR",
    "research report on SOFI",
    "write me a full report on COIN",
    "I want deep research on ASML",
    "comprehensive analysis of GOOG",
    "in-depth review of META",
    "everything you know about UBER",
  ];
  for (const t of explicit) {
    it(`treats "${t}" as an explicit crew request`, () => {
      expect(wantsFullAnalysis(t)).toBe(true);
    });
  }

  // The readout's "is it too late to buy NVDA" family — these went to the crew
  // (median 253 s) when a grounded answer in seconds was what people wanted.
  const fast = [
    "is NVDA a buy?",
    "is it too late to buy NVDA?",
    "should I worry about AMD's margins?",
    "what's going on with TSLA today",
    "how risky is my portfolio?",
    "thoughts on PLTR at this price",
    "analyze MSFT",
    "is SOFI overvalued",
    "tell me about COIN",
  ];
  for (const t of fast) {
    it(`does not treat "${t}" as an explicit crew request`, () => {
      expect(wantsFullAnalysis(t)).toBe(false);
    });
  }
});

describe("isReuseFollowUp", () => {
  const reuse = [
    "so yes or no?",
    "yes or no",
    "simpler",
    "explain that more simply",
    "shorter please",
    "tl;dr",
    "ELI5",
    "3 bullets",
    "just give me 3 bullets",
    "what about the risks?",
    "and the bear case?",
    "why?",
  ];
  for (const t of reuse) {
    it(`reuses the last turn's data for "${t}"`, () => {
      expect(isReuseFollowUp(t)).toBe(true);
    });
  }

  const fresh = [
    "is AMD a buy right now?",
    "what about AMD instead", // a new subject, not a reformat
    "compare it to Intel's latest quarter and tell me which has better margins",
    "find me cheap energy stocks",
  ];
  for (const t of fresh) {
    it(`fetches fresh data for "${t}"`, () => {
      expect(isReuseFollowUp(t)).toBe(false);
    });
  }
});

describe("hasSubject", () => {
  it("is true when the message names a ticker", () => {
    expect(hasSubject({ userPrompt: "is NVDA a buy?" })).toBe(true);
  });

  it("is true when the viewed page pins a ticker", () => {
    expect(
      hasSubject({
        userPrompt: "is this a buy?",
        pageContext: { kind: "stock", ticker: "NVDA", snapshot: "" },
      })
    ).toBe(true);
  });

  it("is true on a portfolio page even with no ticker in the message", () => {
    expect(
      hasSubject({
        userPrompt: "how am I doing?",
        pageContext: { kind: "portfolio", snapshot: "" },
      })
    ).toBe(true);
  });

  it("is true when the user asks about their own holdings", () => {
    expect(
      hasSubject({ userPrompt: "how risky is my portfolio?", portfolioContext: "AAPL 10 shares" })
    ).toBe(true);
  });

  it("is false for open-ended discovery with nothing to anchor on", () => {
    expect(hasSubject({ userPrompt: "what should I buy?" })).toBe(false);
  });
});

/** resolveIntent's non-model context, with sensible defaults per test. */
function ctx(over: Partial<Parameters<typeof resolveIntent>[1]> = {}) {
  return { userPrompt: "is NVDA a buy?", allowClarify: true, ...over };
}

describe("resolveIntent", () => {
  it("defaults to fast when the router returns junk", () => {
    expect(resolveIntent(null, ctx()).intent).toBe("fast");
    expect(resolveIntent({ intent: "banana" }, ctx()).intent).toBe("fast");
  });

  it("keeps full_analysis when the user explicitly asked for the crew", () => {
    const r = resolveIntent({ intent: "full_analysis" }, ctx({ userPrompt: "full analysis of NVDA" }));
    expect(r.intent).toBe("full_analysis");
  });

  it("downgrades full_analysis to fast when the ask was not explicit", () => {
    // The core readout fix: 80/138 Auto turns went to the crew unasked.
    const r = resolveIntent({ intent: "full_analysis" }, ctx({ userPrompt: "is it too late to buy NVDA?" }));
    expect(r.intent).toBe("fast");
  });

  it("honours an explicit crew request even when the router says fast", () => {
    const r = resolveIntent({ intent: "fast" }, ctx({ userPrompt: "run the crew on NVDA" }));
    expect(r.intent).toBe("full_analysis");
  });

  it("honours the Run full analysis button regardless of wording", () => {
    const r = resolveIntent({ intent: "fast" }, ctx({ forceFullAnalysis: true }));
    expect(r.intent).toBe("full_analysis");
  });

  it("keeps discover for an un-tickered screen", () => {
    const r = resolveIntent({ intent: "discover" }, ctx({ userPrompt: "find cheap energy stocks" }));
    expect(r.intent).toBe("discover");
  });

  it("asks structured clarifying questions when the target is genuinely unknown", () => {
    const r = resolveIntent(
      {
        intent: "clarify",
        clarify: [
          {
            header: "Horizon",
            question: "What's your time horizon?",
            options: [
              { label: "Long term", description: "3+ years, compounders" },
              { label: "Swing", description: "Weeks to months" },
            ],
          },
          { header: "Amount", question: "Roughly how much?", options: ["Under $1k", "$1k–$10k", "$10k+"] },
        ],
      },
      ctx({ userPrompt: "what should I buy?" })
    );
    expect(r.intent).toBe("clarify");
    expect(r.clarify).toHaveLength(2);
    expect(r.clarify?.[0].options[0]).toEqual({ label: "Long term", description: "3+ years, compounders" });
    expect(r.clarify?.[1].options.map((o) => o.label)).toEqual(["Under $1k", "$1k–$10k", "$10k+"]);
  });

  it("still reads the legacy single-question shape", () => {
    const r = resolveIntent(
      {
        intent: "clarify",
        clarifyQuestion: "What are you optimising for?",
        clarifyChips: ["Growth", "Income", "Quality"],
      },
      ctx({ userPrompt: "what should I buy?" })
    );
    expect(r.intent).toBe("clarify");
    expect(r.clarify?.[0].question).toBe("What are you optimising for?");
    expect(r.clarify?.[0].options.map((o) => o.label)).toEqual(["Growth", "Income", "Quality"]);
  });

  it("never clarifies when the page context already names the stock", () => {
    const r = resolveIntent(
      { intent: "clarify", clarifyQuestion: "Which stock?", clarifyChips: ["a", "b", "c"] },
      ctx({
        userPrompt: "is this a buy?",
        pageContext: { kind: "stock", ticker: "NVDA", snapshot: "" },
      })
    );
    expect(r.intent).toBe("fast");
    expect(r.clarify).toBeUndefined();
  });

  it("never clarifies twice in a row", () => {
    const r = resolveIntent(
      { intent: "clarify", clarifyQuestion: "Which sector?", clarifyChips: ["a", "b", "c"] },
      ctx({ userPrompt: "what should I buy?", allowClarify: false })
    );
    expect(r.intent).toBe("discover");
  });

  it("does not clarify when amount, level and goal are already given (the Priya case)", () => {
    const r = resolveIntent(
      { intent: "clarify", clarifyQuestion: "What's your risk tolerance?", clarifyChips: ["a", "b", "c"] },
      ctx({
        userPrompt:
          "I have $5,000 to invest, I'm a complete beginner, and I want long-term growth over 10 years. Where do I start?",
      })
    );
    expect(r.intent).toBe("discover");
  });

  it("does not clarify when the ask already states a style", () => {
    const r = resolveIntent(
      { intent: "clarify", clarifyQuestion: "What are you optimising for?", clarifyChips: ["a", "b", "c"] },
      ctx({ userPrompt: "ideas for dividend income" })
    );
    expect(r.intent).toBe("discover");
  });

  it("still clarifies a genuinely bare ask", () => {
    const r = resolveIntent(
      { intent: "clarify", clarifyQuestion: "What are you after?", clarifyChips: ["a", "b", "c"] },
      ctx({ userPrompt: "what's good right now?" })
    );
    expect(r.intent).toBe("clarify");
  });

  it("drops a clarify with no usable question or chips", () => {
    const r = resolveIntent({ intent: "clarify" }, ctx({ userPrompt: "what should I buy?" }));
    expect(r.intent).toBe("discover");
  });

  it("caps clarify at three questions of four options", () => {
    const q = { question: "Which?", options: ["a", "b", "c", "d", "e", "f"] };
    const r = resolveIntent({ intent: "clarify", clarify: [q, q, q, q, q] }, ctx({ userPrompt: "what's good right now?" }));
    expect(r.clarify).toHaveLength(3);
    expect(r.clarify?.[0].options).toHaveLength(4);
  });

  it("routes short reformat follow-ups to fast, never to the crew", () => {
    const r = resolveIntent({ intent: "full_analysis" }, ctx({ userPrompt: "so yes or no?" }));
    expect(r.intent).toBe("fast");
  });

  it("only ever returns one of the four intents", () => {
    const all: Intent[] = ["fast", "discover", "clarify", "full_analysis"];
    for (const raw of ["fast", "discover", "clarify", "full_analysis", "simple", "agent", ""]) {
      expect(all).toContain(resolveIntent({ intent: raw }, ctx({ userPrompt: "what should I buy?" })).intent);
    }
  });
});
