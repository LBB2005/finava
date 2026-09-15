# W4-1: Chat cites facts (the model never does arithmetic)

**Wave 4 · merge 1st · port 3011 · branch `feat/w4-1-chat-cites-facts`** · start from `main` with Waves 1–3 merged

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W4-1-chat-cites-facts.md in the same folder. Confirm Waves 1–3 are merged into main (the src/lib/facts layer must exist). Set up the worktree exactly as the README says (plan id w4-1-chat-cites-facts, port 3011), then execute the plan with superpowers:executing-plans and TDD. Stay inside the owned files. When done, open a PR per the README rules.
```

## Why
- The fact-check found errors in the model's own arithmetic (a Pfizer CEO's $1.0M buy shown as $10.3M), stale recall (QQQ fee) and period labels, not in the feeds.
- Chat, stock page and Research must quote the same numbers (W3-1 made the numbers; this plan makes chat use them).
- 6 testers wanted clickable primary sources; 12 wanted "I can't answer X" up front instead of a 4-minute report ending in "go check IBKR".
- Discover answered an ETF question with individual stocks, then contradicted itself.

## Owned files
- `src/app/api/chat/route.ts`, `src/agents/ceo.ts` (facts block + source handling), `src/agents/discovery.ts`, sub-agent prompts
- `src/components/chat/ChatContainer.tsx` / the context payload in `ChatEngine.tsx` (payload building only)
- `src/components/chat/answer/KeyNumbers.tsx`: source links only
- new: `src/lib/facts/promptBlock.ts` (+ tests), `src/lib/capabilityCheck.ts` (+ tests)

## Tasks
1. **`promptBlock.ts`**: renders `TickerFacts`/`PortfolioFacts` as a compact fenced block with stable IDs (`[F:AAPL.pe]`). The prompt rule: every number in the answer must come from the block and cite its ID; derived comparisons must use precomputed fields. When a needed number isn't in the block, write "Unavailable".
2. **Precompute what the model used to calculate**: % from 52w high, position $ downside at −10/−20/−30%, insider transaction totals, weight changes. Put them in facts (extend `src/lib/facts` minimally, flagged in the PR) and remove any prompt instruction asking the model to compute.
3. **Post-generation number check**: scan the final answer for numbers with a nearby `[F:…]` citation and verify value equality (with normalization). A mismatch gets replaced with the fact value and logged. Strip the citation IDs into source chips for the UI (source name + as-of + link).
4. **Source links**: facts carry a URL where one exists (SEC filing index, news article URL, Form 4 filing). KeyNumbers renders the source chip as a link.
5. **`capabilityCheck.ts`**: before running a full analysis, check whether the question needs data we don't have (options chain/IV, bond duration, ETF holdings/weights, price targets if premium-gated). If the core data is missing, answer fast: "I can't get X for this ticker, so here's what I can tell you…" and offer the rest. Tests for the question → required-data map.
6. **Discover ETF honesty**: if the request is about ETFs or funds, don't run the stock scout. Route to the fast lane with an explicit "Discover screens individual stocks; for ETFs, here's what to compare…" and use fund facts where available. Never present stock picks as the answer to an ETF question. Test it with Priya's prompt.
7. Pass `experienceLevel` (W2-3) into every prompt: beginner means define terms inline, skip TA indicators, 3–5 sentence answers.

## Acceptance
- Seeded arithmetic test: the Pfizer $1.0M buy renders as $1.0M from facts, and a mismatch replacement is covered by a unit test.
- Priya's ETF prompt never returns individual stocks as the answer.
- typecheck, lint and tests are green.
