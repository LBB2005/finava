# Advice-line audit: prompt instructions that touch recommendations

**Status:** documentation for legal review. It is not legal advice and not a policy decision.
**Branch:** `fix/w1-3-prompt-truth` (beta-fix roadmap W1-3), prepared 15 Sep 2026.
**Question for the reviewer:** does the wording below keep Finava on the "impersonal research publication" side of the line, and are the remaining items (section 4) acceptable?

## 1. Why this changed

In the September 2026 beta, the crew prompt *required* stop-losses, trim levels and "actionable recommendations". The same prompt also contained the no-personalized-advice rule. The model resolved the contradiction by writing share-count rebalance plans and labelling them "not personalized advice". An inferred investing profile was also described to users as "your stated profile".

The fix makes the compliance block the single source of truth. Every instruction that contradicted it has been removed or rewritten.

## 2. Instructions: before and after

### 2.1 Crew (CEO) system prompt: `src/agents/ceo.ts`

| # | Before | After |
|---|---|---|
| 1 | Job step 3: "Synthesize their findings into clear, **actionable investment insights**" | "Synthesize their findings into clear, evidence-backed research on the securities" |
| 2 | "Always provide **specific, actionable recommendations** backed by the data" | "Back every conclusion about a security with specific data from the sub-agents" |
| 3 | "End with a clear **'Summary & Recommendation'** section" | "End with a clear 'Summary & Verdict' section. The verdict is about the security (bull/bear balance, valuation, key risks), not an instruction to the user" |
| 4 | Required section **"🎯 Triggers & Guardrails"**: "every recommendation set ends with concrete, actionable guardrails: **rebalance thresholds, sell signals, and stop-loss / trim levels**. Risk identification without triggers is incomplete." | Required section **"🔭 What Would Change the View"**: "scenario levels about the stock and the concrete developments (earnings, guidance, valuation, regulation) that would break or strengthen the thesis. These describe the security, never what the user should do with their position." |
| 5 | Compliance block: impersonal framing; if asked, present both ways and say the decision is theirs, ideally with a licensed adviser. | Unchanged, plus it is marked as "the single source of truth for advice; nothing else in this prompt overrides it", with explicit lists. **Allowed:** scenario levels about the stock ("below $X the valuation case breaks"), what would change the view, risk factors, and the portfolio's measured exposures (weights, concentration, beta) stated as facts. **Forbidden:** exit or sell-price levels for the user's positions (no stop orders, no "reduce at $X"), share counts to buy or sell, rebalancing plans or target allocations, position-size rules of thumb applied to the user's holdings ("above the 5% guideline"), and "you should buy/sell/hold". **Profile:** the style is inferred, so the model says "based on your holdings" and must never say "your stated profile", label the user with a risk tolerance, or claim the user stated their goals. |
| 6 | (none) | New "Portfolio figures" rule: weights, market values, cost basis and P&L come only from the computed holdings table, quoted verbatim. |
| 7 | (none) | New "Today" block: the current date and US market status, and that "an upcoming earnings date is an estimate unless … confirmed; label it '(estimated)'". |

**Unchanged, listed because they touch recommendations (these are restrictions):**
- "If the Technical Agent reports DATA UNAVAILABLE … you MUST NOT make any trim/hold/buy calls that depend on current price for that ticker."
- "Confidence in a recommendation must match the quality of supporting data."
- "Note this is not financial advice."

### 2.2 Skeptic review and revision pass: `src/agents/ceo.ts` (`critiqueAndRevise`)

| # | Before | After |
|---|---|---|
| 8 | Revision instruction: "End with a **'🎯 Triggers & Guardrails'** section: concrete **rebalance thresholds, sell signals, and stop-loss / trim levels**." | "End with a '🔭 What Would Change the View' section: scenario levels about the stock and the evidence that would break or strengthen the thesis. Never exit prices, position sizes or share counts for the user's holdings." Plus: "Remove anything that reads as personal advice: exit or sell-price levels for the user's positions, share counts, rebalancing plans, or 'you should buy/sell'." |
| 9 | (none) | New skeptic check, **"Advice line"**: flag exit or sell-price levels for the user's own positions, share counts, rebalancing plans, "you should buy/sell", or an inferred profile described as stated. Scenario levels about the stock are fine. |

Unchanged: the skeptic's "Data masking" check flags "confident price-based calls (trim/hold, position sizing, cost-basis comparisons) despite … no live price data". It is a detection rule, not an instruction to give such calls.

### 2.3 Quick chat system prompt: `src/app/api/chat/route.ts`

| # | Before | After |
|---|---|---|
| 10 | "…help users research stocks, analyze their portfolio, and make informed investment decisions." | "…help users research stocks, understand their portfolio, and make informed investment decisions **of their own**." |
| 11 | "Be concise, data-driven, **and actionable**." | "Be concise and data-driven." |
| 12 | COMPLIANCE: never personalized advice (what to buy/sell/hold or how to allocate), even if asked directly; give impersonal analysis both ways; the decision is theirs with a licensed adviser; general analysis is fine; note it is not financial advice. | Unchanged, plus: scenario levels about the stock itself and the portfolio's measured weights and concentration are fine as facts. Never exit or sell-price levels for the user's positions, share counts to trade, rebalancing plans, or position-size rules of thumb applied to their holdings. The user's style is inferred: say "based on your holdings", never "your stated profile", and never label them with a risk tolerance. |
| 13 | (none) | New "About Finava" block: plans, prices and the trial, read from `src/lib/plans.ts`. Product questions are public information and are answered directly. |

### 2.4 Discovery synthesis prompt: `src/agents/discovery.ts`

| # | Before | After |
|---|---|---|
| 14 | (none) | "This is impersonal research on the securities: no share counts, position sizes or 'you should buy/sell'." |
| 15 | (none) | Date line and "(estimated)" rule for unconfirmed earnings dates. |

Unchanged, flagged for review: the output format asks for "## 🥇 Top Conviction: the 3 best ideas and why" and ends with "Not financial advice." The screen is generic and never uses the user's portfolio.

## 3. Disclaimer text currently shown

- **Chat composer footer** (`src/components/chat/ChatInput.tsx`): "Responses are AI-generated and may contain errors · Not financial advice · Always do your own research"
- **Model-written footers.** The prompts require a "not financial advice" note. Example from a live crew run (section 5.1): "This report is produced by Finava as an impersonal research publication and does not constitute personalized investment advice. … Consult a licensed financial adviser before making investment decisions."
- **Landing FAQ** (`src/components/landing/FAQ.tsx`): "Is Finava giving me financial advice?"
- **Terms / Privacy:** `/terms`, `/privacy`. The entity name, postal address and lawyer review are still open items from the legal-compliance work.

## 4. Remaining items outside this change (for the reviewer's attention)

These still use recommendation language. They belong to other files and sessions and were not changed here.

| Where | Text | Note |
|---|---|---|
| `src/components/chat/MessageList.tsx` (starter prompts) | "Which positions should I consider trimming?" and "Suggest a rebalance back to my targets" | The UI *invites* personal-advice questions. The model now declines them, but the prompts set the wrong expectation. |
| `src/agents/sub-agents/dcf-agent.ts` | "…and buy/hold/sell signal vs current price" | Impersonal (about the security), but it produces a buy/sell label. |
| `src/agents/skills/sentiment.ts` | "extreme bullish sentiment as a sell signal, extreme bearish as a buy signal" | Impersonal signal language. |
| `src/agents/sub-agents/insider-agent.ts`, `sentiment-agent.ts` | "provide actionable insights" / "a clear, actionable report" | Sub-agent wording. The CEO rewrites the output under the rules above. |
| `src/app/api/briefing/generate/route.ts` | "**Opportunities** (1-2 specific actionable ideas from the data)" | The weekly briefing prompt was not in scope for W1-3. |
| `src/lib/userPreference.ts` (`buildStylePrompt`) | Injects "## User Investing Profile … Risk tolerance: …" and "Tailor … to match this profile." | The header does not say the profile is inferred. The CEO rule now forbids describing it as stated or labelling the user, but the block itself should say "inferred". |

## 5. Example outputs (live, 15 Sep 2026, dev account with a 10-holding demo book)

These are excerpts from real runs on the W1-3 branch. The figures come from live data feeds on that day and are shown only to illustrate the framing.

### 5.1 Full crew run on a held stock

**Prompt:** "Full analysis of NVDA. I hold it. Should I trim my position, and where should I set a stop-loss? Also what weight is NVDA in my portfolio, and when are its next earnings?"

> Per the Finava portfolio table (computed from your holdings, prices as of 15 Sep 2026, 15:55 ET):
> - **Portfolio weight: 13.1%**, your largest single position
>
> **17 November 2026 (estimated)**. Source: Earnings Agent. The qualifier "estimated" applies because the Earnings Agent did not confirm this as a company-announced date.
>
> > **"Should I trim my position, and where should I set a stop-loss?"**
>
> Finava's compliance framework prohibits issuing personal exit levels, sell prices, or share-count guidance tied to an individual's holdings. What this report *can* do, and does below, is present the bull and bear evidence, the key technical support levels for the security, and what would materially change the investment thesis. The decision is yours to make, ideally with a licensed adviser.

From the "🔭 What Would Change the View" section of an earlier run with the same prompt:

> - NVDA price breaking decisively and sustaining below the 200-day SMA ($197.77, Technical Agent) would signal structural trend breakdown and remove the key long-term support argument

That earlier run also said the 13.1% weight was "above the ~5–7% guideline for a single name in a moderate-risk, diversified portfolio". That is a sizing rule of thumb plus a risk label on the user. Rows 5 and 12 were tightened in response, and the re-run (quoted above) no longer does it.

### 5.2 Quick chat: a direct "should I sell" question

**Prompt:** "Should I sell some of my NVDA? How many shares would you trim, and what is its weight in my portfolio?"

> **NVDA's weight in your portfolio: 13.1%** (market value $8,483.60, unrealized gain +$4,083.60 / +92.8%).
>
> I can't tell you whether to sell, how many shares to trim, or give you a rebalancing target. That would be personalized investment advice, which is outside what Finava provides as an impersonal research publication. Those decisions are best made with a licensed financial adviser who knows your full situation.
>
> What I *can* offer is **impersonal analysis** of NVDA itself, on both sides: …

### 5.3 Quick chat: a product question (previously refused)

**Prompt:** "Does this app cost money?"

> | Plan | Price | Key Limits |
> |------|-------|------------|
> | **Free** | $0 | 2 full crew analyses/month, 1 watchlist, no brokerage linking |
> | **Analyst** | $20/month or $200/year | 30 full crew analyses/month, unlimited watchlists, brokerage linking, weekly AI briefings |
> | **Pro** | $60/month or $600/year | Full crew analyses (fair use), unlimited watchlists, brokerage linking, weekly AI briefings |
>
> **New users get a 3-day Pro trial, no credit card required.**

## 6. How it is enforced in code

- `src/agents/ceo.test.ts`: the assembled crew prompts (the system prompt plus the revision instruction) contain none of `stop-loss`, `trim level`, `actionable recommendation`, `rebalance threshold`. They do contain the research-framing, "based on your holdings" and no-risk-label rules.
- `src/app/api/chat/route.test.ts` and `src/agents/discovery.test.ts`: the same banned-phrase check on the chat and discovery prompts.
- `src/lib/aboutFinava.test.ts`: the product block lists the plans and prices from `plans.ts`, and never a plan that is not for sale.
