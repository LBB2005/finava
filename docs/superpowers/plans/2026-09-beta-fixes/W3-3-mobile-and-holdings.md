# W3-3: Mobile layouts & holdings management

**Wave 3 · merge 3rd · port 3013 · branch `fix/w3-3-mobile-holdings`** · start from `main` with Waves 1–2 merged

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W3-3-mobile-and-holdings.md in the same folder. Confirm Waves 1–2 are merged into main. Set up the worktree exactly as the README says (plan id w3-3-mobile-holdings, port 3013), then execute the plan with superpowers:executing-plans. Verify every page in the Browser pane at 375px and desktop with screenshots. Stay inside the owned files. When done, open a PR per the README rules.
```

## Why
- At phone width, Portfolio clips Day/Value/Return, the watchlist collapses to 52 px, Settings shrinks to a 70 px column, and the Research board clips Score/Grade.
- Holdings can't be removed or edited: the delete code exists but only the compact card renders, with no button. Re-adding silently overwrites.
- A browser tester landed on a pre-filled $70k demo portfolio with no "sample" label.

## Owned files
- `src/app/portfolio/page.tsx` and portfolio components
- `src/components/watchlist/WatchlistSplitRail.tsx` and watchlist table components
- `src/app/settings/page.tsx`: **layout/CSS only** (content was changed in W1-4 and W2-3)
- `src/components/research/BoardLeaderboard.tsx` and board layout: **layout only**
- `src/components/layout/HoldingCard.tsx`, `src/components/layout/Sidebar.tsx` (holding actions), `src/hooks/usePortfolio.ts`
- `src/app/globals.css`: responsive utilities only

**Do not touch:** chat components, facts/score logic.

## Tasks
1. **Audit** at 375, 414, 768 and 1280 px (Browser pane `resize_window`). Screenshot the before state of Portfolio, Watchlist, Settings, Research board, stock page and Chat.
2. **Portfolio**: under 640 px, the holdings table becomes stacked rows (ticker + value on line 1, day / return / weight on line 2). No horizontal body scroll. The chart hero stays full width.
3. **Watchlist**: the split rail stacks (list on top, detail below) under 768 px. It never collapses to a sliver.
4. **Settings**: nav becomes a top segmented/scrollable tab bar on mobile; the content goes full width.
5. **Research board**: a priority-column pattern. Keep Ticker, Score and Grade; move the other columns into an expandable row.
6. **Holdings edit/delete**: render edit (qty, cost basis per share) and delete (with the standard confirm modal) on the full and compact cards. Re-adding an existing ticker asks "Add to position" (weighted-average cost) or "Replace"; it never silently overwrites. Plaid-synced holdings are read-only with a note. Tests for the `usePortfolio` merge math.
7. **Demo data**: if any account can show seeded or demo holdings, show a clear "Sample portfolio — replace with yours" banner with a one-click clear. If seeding only happens in the test setup, note that in the PR and skip.

## Acceptance
- Before/after screenshots for each page at 375 px and desktop, in the PR.
- No element wider than the viewport (check `document.documentElement.scrollWidth <= innerWidth` via javascript_tool on each page).
- typecheck, lint and tests are green.
