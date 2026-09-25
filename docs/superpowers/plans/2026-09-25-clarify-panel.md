# Clarify Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clarifying questions ask in a panel docked at the composer (1–3 tabbed questions with described options), and the transcript keeps only a compact receipt line.

**Architecture:** A pure module `src/lib/chat/clarify.ts` owns the shapes, sanitising, pending-state derivation and prompt folding. The router and the scout emit structured questions. ChatEngine persists them on an assistant message. GlobalComposer swaps `ChatInput` for `ClarifyPanel` while one is pending. The reply rides on the user message as `clarifyReply`.

**Tech Stack:** Next.js (app router), React, zustand, zod, Firestore via the messages API, vitest.

Spec: `docs/superpowers/specs/2026-09-25-clarify-panel-design.md`

---

### Task 1: `clarify.ts` pure module (TDD)

**Files:** Create `src/lib/chat/clarify.ts` and `src/lib/chat/clarify.test.ts`. Modify `src/types/chat.ts` (the `ChatMessage` fields and the `discover_clarify` event).

- [ ] Write failing tests for these cases:
  - `cleanClarify` caps at 3 questions and 4 options, drops "Other", dedupes and trims, fills missing headers, and drops questions with fewer than 2 options. It returns null on garbage. It accepts plain strings as options and the legacy `{clarifyQuestion, clarifyChips}` shape.
  - `pendingClarifyOf` returns null unless the last message is an assistant message with `clarify`. It returns the original prompt and mode from the preceding user message.
  - `foldClarification` handles both answers and a skip.
  - `replyContent` and `receiptText` produce the history text and the receipt line.
- [ ] Run `npx vitest run src/lib/chat/clarify.test.ts`. Expect FAIL.
- [ ] Implement the module and add the types.
- [ ] Run the tests again. Expect PASS.
- [ ] Commit.

### Task 2: Router emits structured questions

**Files:** Modify `src/lib/chat/intent.ts`, `src/lib/chat/intent.test.ts` and `src/app/api/classify/route.ts` (maxTokens 200 → 600).

- [ ] Update the clarify tests to expect `r.clarify` (a `ClarifyQuestion[]`). Add a test that the legacy shape still resolves.
- [ ] Update `ROUTER_SYSTEM_PROMPT` to the new JSON shape. Make `resolveIntent` use `cleanClarify`. `ResolvedIntent` becomes `{ intent, clarify? }`.
- [ ] Run `npx vitest run src/lib/chat/intent.test.ts`. Expect PASS.
- [ ] Commit.

### Task 3: Persistence

**Files:** Modify `src/lib/schemas/conversation.ts`, `src/app/api/conversations/[id]/messages/route.ts` and its test, and `src/lib/chat/storedMessage.ts` and its test.

- [ ] Add failing tests: the route stores `clarify` and `clarifyReply`, and the stored message round-trips them after re-cleaning.
- [ ] Add zod schemas for both fields. Write them natively to Firestore. Map them in `toStoredMessage` and `fromStoredMessage`.
- [ ] Run the tests. Expect PASS.
- [ ] Commit.

### Task 4: Scout emits structured questions

**Files:** Modify `src/agents/sub-agents/scout-agent.ts` and `src/app/api/live/discover/scout/route.ts` (the error message). Also update any scout test that asserts on `chips`.

- [ ] `discover_clarify` carries `questions: ClarifyQuestion[]`: one "Style" question with 3 described options.
- [ ] Run `npx vitest run src/agents src/app/api/live`. Expect PASS.
- [ ] Commit.

### Task 5: ChatEngine and store wiring

**Files:** Modify `src/stores/chatStore.ts` (`SendRequest.clarifyReply`) and `src/components/chat/ChatEngine.tsx`.

- [ ] Delete the `pendingClarify` Map. In `processSend`, derive `pendingClarifyOf(prior)`, fold the lane prompt, stamp `clarifyReply` on the user message, and pass `allowClarify=false` to the lanes.
- [ ] `runAuto(text, …, allowClarify)` commits `{content: questions text, clarify}`.
- [ ] `runDiscoverMode` commits the scout's questions the same way. When `allowClarify` is false, it commits the scout framing as plain text instead.
- [ ] Run `npx tsc --noEmit` and `npx vitest run src/lib/chat src/stores`. Expect PASS.
- [ ] Commit.

### Task 6: UI

**Files:** Create `src/components/chat/ClarifyPanel.tsx`. Modify `src/components/chat/GlobalComposer.tsx`, `src/components/chat/Message.tsx` and `src/app/globals.css` (`.clarify-*` styles plus a reduced-motion guard).

- [ ] Build the panel as described in the spec's UI section. GlobalComposer renders it on `/chat` when the viewed conversation has a pending clarify and isn't streaming.
- [ ] In Message.tsx, a clarify assistant message renders null, and a user message with `clarifyReply` renders as the receipt line.
- [ ] Run `npx tsc --noEmit` and `npm run lint`. Expect clean.
- [ ] Commit.

### Task 7: Verify in the browser

- [ ] Start the dev preview with dev-auth on. In Auto, send "what should I buy?". The panel appears.
- [ ] Answer it. The receipt line appears, then the answer streams.
- [ ] Reload mid-question. The panel is restored.
- [ ] Skip. The receipt says it was skipped, and the answer states its assumptions.
- [ ] Check dark mode and a phone-width layout.
- [ ] Run the full `npx vitest run` and the build.
