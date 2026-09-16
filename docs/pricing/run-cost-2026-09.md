# What a run costs — Sep 2026

Measured 16 Sep 2026 on `main` @ `e7c6590` plus branch `fix/w3-4-credits-pricing`. 30 real runs through the four lanes, against a local dev server. Raw per-run data: [`run-cost-2026-09.json`](run-cost-2026-09.json). Re-run with [`scripts/measure-run-cost.ts`](../../scripts/measure-run-cost.ts).

**Why this exists.** Before this, every paid plan capped a run at 300 credits (~$0.30), from Free up to the $100/mo Quant tier, and the allowances were placeholders marked `TUNE`. Nobody had measured a run. The beta readout: 0 of 50 testers would pay.

## Headline

- **A full analysis costs about $0.19. A deep-research run costs about $0.45. A fast answer costs half a cent.**
- **The old 300-credit cap would have cut off every deep-research run.** The median deep run is 446 credits and the cheapest was 304. Admins were uncapped, so nobody saw it happen.
- **Current prices hold a 70%+ gross margin** once allowances are sized to the measured costs. No Stripe price changes are needed. Quant's old allowance was a 57% margin at full use (49% on annual billing); it's now 70%.
- **The CEO's Sonnet synthesis is most of a crew run's cost** (83% of full-analysis credits). Making sub-agents cheaper barely moves the total. Making the synthesis cheaper would.
- Total spend for the 30-run measurement: **$4.33**.

## Measured cost per run

1 credit = $0.001 of model spend (`CREDIT_USD`). Percentiles are nearest-rank.

| Lane | Runs | p50 credits | p90 credits | max | p50 $ | p90 $ | p50 time | p90 time |
|---|---|---|---|---|---|---|---|---|
| fast | 10 | 5.3 | 6.4 | 7.1 | $0.005 | $0.006 | 8 s | 11 s |
| full analysis | 10 | 188 | 223 | 242 | $0.19 | $0.22 | 211 s | 231 s |
| discover (quick) | 5 | 88 | 91 | 91 | $0.09 | $0.09 | 48 s | 93 s |
| deep research | 5 | 446 | 521 | 521 | $0.45 | $0.52 | 334 s | 335 s |

### Where the money goes

| Lane | Split by model (share of credits) | Biggest spender |
|---|---|---|
| fast | Haiku 100% (answer 80%, follow-up chips 20%) | the answer itself |
| full analysis | Sonnet 83%, GPT-5.5 11%, Haiku 4%, Gemini 2% | CEO synthesis 83%, analyst agent 11% |
| discover | Sonnet 97%, Haiku 3% | scout selection 56%, CEO 41% |
| deep research | GPT-5.5 41%, Sonnet 55%, other 4% | CEO 37%, DCF 19%, comparables 16%, risk 11%, analyst 10% |

In a full analysis the CEO runs draft → skeptic → revision, which is two full Sonnet passes over every agent's output. Sub-agents mostly route to Gemini and cost almost nothing. Deep research adds the DCF, comparables and risk agents on GPT-5.5 and Sonnet, so the crew outspends the CEO (56% vs 37%).

## Per-run caps (applied in `PER_RUN_CAP`, `src/lib/plans.ts`)

Rule: about 1.5× the lane's p90, rounded up. A normal run never sees the cap; only a runaway does. **Every tier gets the same caps.** The same question does the same work on Free and on Quant, so a lower per-run cap on a cheaper tier only produces worse answers. The tiers differ in how many runs their monthly credits buy.

| Lane | p90 | 1.5× p90 | **Cap** | Old cap |
|---|---|---|---|---|
| fast | 6.4 | 9.5 | **20** | 300 (not enforced) |
| full analysis | 223 | 335 | **350** | 300 |
| discover | 91 | 136 | **150** | 300 |
| deep research | 521 | 782 | **800** | 300 |

- **Fast breaks the 1.5× rule on purpose.** A fast answer is one Haiku call bounded by `max_tokens`, with a worst case around 16 credits. A cap of 10 would flag legitimately long answers as runaways. The fast lane also has no mid-run abort point, so its cap is a monitoring threshold (`run_cost_over_cap` warning), not a kill-switch.
- **Full, discover and deep stop gracefully** at the cap. The CEO loop checks spend before each synthesis turn and ships what it has, with *"Run stopped at your plan's per-run limit — the analysis above is partial"*. The check runs between rounds, so a run can finish somewhat over its cap. That overshoot is part of why the cap sits well above p90, and it's logged too.
- Admins and dev stay uncapped. `ENFORCE_CAPS_FOR_ADMINS=1` makes them hit caps like a subscriber.

## Monthly allowances (applied in `PLANS`)

### Margin rule

**Gross margin ≥ 70% for a subscriber who uses 100% of their credits, on both monthly and annual billing.** Checking at full use means the floor holds without guessing how much people use. Annual is the binding case: $200/yr is $16.67/mo of revenue against the same allowance.

Cost of revenue per subscriber, as counted here:
- **Model spend:** credits × $0.001, at the rates in `usage.ts` `MODEL_PRICING`.
- **Stripe:** 2.9% + $0.30 per charge (annual: one charge spread across 12 months).

Left out of that cost: flat data subscriptions (Polygon, Finnhub, etc. are fixed monthly, not per user), Vercel function time, Firestore, and Langfuse. None were measured per run. A crew run holds a function for 3–5 minutes but is almost all I/O wait, which Active-CPU pricing mostly doesn't bill. Treat the margins below as an upper bound until those are attributed.

| Plan | Price | Credits / month | Max model $ | Margin, monthly @100% | Margin, annual @100% | Was |
|---|---|---|---|---|---|---|
| Free | $0 | **600** | $0.60 | n/a (acquisition cost) | n/a | 400 |
| Analyst | $20 / $200 | **4,400** | $4.40 | 73.6% | 70.5% | 4,000 |
| Pro | $60 / $600 | **13,500** | $13.50 | 74.1% | 70.0% | 15,000 |
| Quant | $100 / $1,000 | **22,500** | $22.50 | 74.3% | 70.1% | 40,000 (56.8% / 49.1%) |

Daily and weekly ceilings were resized so a single deep run (worst case ~520) fits in a day on every plan that has Deep Research:

| Plan | Daily | Weekly | Monthly | Deep Research runs / month |
|---|---|---|---|---|
| Free | 250 (was 60) | 600 (was 200) | 600 | **1** (was 2) |
| Analyst | 800 (was 400) | 2,000 (was 1,500) | 4,400 | **8** (was 30) |
| Pro | 2,000 (was 1,200) | 6,000 (was 5,000) | 13,500 | limited by credits (~30) |
| Quant | 3,000 | 10,000 (was 12,000) | 22,500 | limited by credits (~50) |

**Deep Research counts were promises the credits couldn't keep.** Analyst advertised 30 deep runs a month, which is ~13,500 credits against a 4,000-credit month. Free advertised 2 (~900 credits) against 400. The counts now fit inside the allowance, and `plans.test.ts` fails if a future edit breaks that.

### Blended margin at an assumed usage

The 100%-use floor is the guarantee. For a realistic picture, assume a typical subscriber:

| Plan | Assumed month | Credits | Model $ | Margin (monthly) |
|---|---|---|---|---|
| Free (active) | 20 fast + 1 full analysis | ~290 | $0.29 | acquisition cost |
| Analyst | 100 fast, 8 full, 4 discover, 2 deep | ~3,280 | $3.28 | 79% |
| Pro | 250 fast, 25 full, 10 discover, 8 deep | ~10,500 | $10.50 | 79% |

These usage mixes are assumptions, not measurements. Nothing in the beta measured per-user monthly volume on a capped plan, because every tester was uncapped. Replace them once testers are on real plans (see below).

### What a buyer sees

The pricing page now turns credits into runs at the measured typical cost (`TYPICAL_RUN_CREDITS`, the rounded p50s):

| Plan | Copy |
|---|---|
| Free | 600 credits / month · Up to 3 full analyses or 120 quick answers · 1 Deep Research run / month |
| Analyst | 4,400 credits / month · Up to 23 full analyses or 880 quick answers · 8 Deep Research runs / month |
| Pro | 13,500 credits / month · Up to 71 full analyses or 2,700 quick answers · Deep Research runs limited only by your credits |

## Putting beta testers on real plans

Allowlisted accounts resolve to uncapped Quant, which is why no beta tester ever hit a limit. An admin can now assign a tester a real plan:

```bash
curl -X POST https://finava.ai/api/admin/tester-plan \
  -H "Authorization: Bearer <admin ID token>" -H "Content-Type: application/json" \
  -d '{"email":"tester@example.com","plan":"Analyst"}'
```

`"plan": null` hands them full access back. It only works for accounts already on `ADMIN_UIDS` / `ADMIN_EMAILS`, and it writes `betaPlan`, never the Stripe-owned `plan` / `subscriptionStatus` fields.

## Caveats

- **Small samples.** 10 runs for fast and full, 5 for discover and deep. p90 of 5 is the maximum. The caps have 1.5× headroom for that reason. Re-measure once real usage exists.
- **Rates are the app's own price table.** Dollar figures come from `MODEL_PRICING` in `src/lib/usage.ts`, whose own header says to verify it against live rate cards. **Reconcile this batch against the OpenRouter and Anthropic invoices for 16 Sep before quoting these numbers externally.**
- **Warm agent cache.** Some tickers hit the shared agent cache (e.g. NVDA's fundamentals and analyst agents), so a few full-analysis runs came in cheap. MSFT ran in 48 s for 71 credits. The CEO synthesis, which is most of the cost, is never cached, so the effect on p90 is small. A cold-cache p50 is likely a little higher.
- **Discover was measured on the quick tier only.** Deep discovery (scout, then crew waves, then synthesis) wasn't run. It's likely closer to deep research and is bounded by the 150-credit discover cap per request. Measure it before selling it.
- **Dev server, not production.** Same code and providers, but no Vercel `maxDuration` enforcement. See the next section.

## Found, not fixed

- **Deep research overruns the route's 300 s limit.** Runs took 310–335 s. `DEEP_BUDGET_MS` is 280 s (W2-2). The synthesis deadline fired at ~70 s, and the remaining ~260 s went to in-flight agents plus the draft → skeptic → revision synthesis. Nothing bounds that tail. On Vercel, `/api/agent`'s `maxDuration = 300` would kill most deep runs before the report finishes. The locally measured cost would be spent and the user would get nothing. Owner: crew budget (W2-2 / `ceo.ts`).
- **The trial is generous relative to Free.** The 3-day trial is Pro-level (2,000 credits/day) with 5 deep runs, a worst case of ~$6 per trial signup. Not changed here.
