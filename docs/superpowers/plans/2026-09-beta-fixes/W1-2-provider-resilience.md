# W1-2: Provider resilience (fail loudly and honestly)

**Wave 1 · merge 3rd · port 3012 · branch `fix/w1-2-provider-resilience`**

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W1-2-provider-resilience.md in the same folder. Set up the worktree exactly as the README says (plan id w1-2-provider-resilience, port 3012), then execute the plan with superpowers:executing-plans and TDD. Stay inside the owned files. When done, open a PR per the README rules.
```

## Why
- Every `generate()` in `src/lib/llm.ts` (sub-agents, router, Discover scout, Skeptic, follow-ups, screener) goes through **one OpenRouter account**. `FALLBACK_MODEL` uses the same gateway (`llm.ts:200–215, 352–355`). On 13 Sep the balance hit 0: Auto silently became plain chat, and Discover returned the same 8 tickers for every query.
- `api/classify/route.ts:114–116`: any error returns `{intent: "simple"}` with no log and no banner.
- `agentMemory.ts` caches swallowed Perplexity/Finnhub failures for 4–24 h for every user.
- `scout-agent.ts:255, 277`: fallback picks are labelled "Top factor fit for your request", and the narrator is told they were "selected EXACTLY".
- Raw vendor errors ("402 Insufficient credits…") reach the thinking trace and the Full modal.

## Owned files
- `src/lib/llm.ts`
- `src/app/api/classify/route.ts`: **catch block only** (W1-3 adds a date line to the prompt)
- `src/lib/agentMemory.ts`
- `src/agents/sub-agents/scout-agent.ts`, `src/agents/discovery.ts` (fallback labelling only)
- new: `src/lib/providerHealth.ts`, `src/app/api/health/**` (extend if it exists), `src/components/layout/DegradedBanner.tsx`
- `src/components/layout/AppShell.tsx`: mount the banner only
- `src/app/api/cron/**`: add the low-balance check

**Do not touch:** `ceo.ts` prompts (W1-3). You may add **one** import and call of `toUserFacingError()` in `ceo.ts` and `Message.tsx`; flag it in the PR.

## Tasks
1. **Real cross-provider fallback** in `llm.ts`: if the OpenRouter call fails with 402/429/5xx/timeout, retry **directly** on a different provider through keys already in `.env.local` (Anthropic direct for Claude-routed agents; OpenAI/Gemini direct if those keys exist; check the env first and list what's available in the PR). Keep the model-attribution badges truthful: record the model that actually answered. Tests with mocked fetch: OpenRouter 402 → direct provider is called → result is attributed correctly.
2. **Provider health state**: `providerHealth.ts` records recent failures per provider in memory, plus a short-TTL Firestore/KV doc if one already exists in the codebase. `GET /api/health` returns `{ llm: ok|degraded|down, data: {...} }`.
3. **Router honesty**: the classify catch logs the error, marks health degraded, and returns `{ intent: "simple", degraded: true }`. Don't change the other branches.
4. **Degraded banner**: slim and dismissible, shown in AppShell when `/api/health` isn't ok. Poll on focus plus every 60 s; no polling while the tab is hidden. Copy: "Some AI providers are having trouble — answers may be slower or less complete." Tokens-only styling.
5. **Low-balance alert**: a cron route checks the OpenRouter key/credits endpoint and emails the admin via the existing Resend setup when the balance is under a threshold env var (`OPENROUTER_ALERT_USD`, default 10). Protect it with `CRON_SECRET` like the existing cron routes.
6. **Never cache failures**: in `agentMemory.ts`, only write the cache when the provider call succeeded and returned non-empty data. Test: failed fetch → nothing written.
7. **Scout fallback honesty**: when the scout fails, label the picks "Scout unavailable — showing today's highest overall factor scores, not a match for your request". Tell the narrator exactly that. Test the narrator input string.
8. **`toUserFacingError(err)`** helper: maps vendor errors to "An AI provider was unavailable for this step." Use it wherever errors go into trace events or saved messages.

## Acceptance
- Simulate an OpenRouter outage (env flag or an invalid key in the worktree): Auto still routes (via the direct provider) or shows the banner; Discover says "Scout unavailable"; nothing gets cached; no "402" text is visible anywhere.
- typecheck, lint and tests are green.
