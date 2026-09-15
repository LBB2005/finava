# W1-1: Chat integrity (stop losing answers and context)

**Wave 1 · merge 1st · port 3011 · branch `fix/w1-1-chat-integrity`**

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W1-1-chat-integrity.md in the same folder. Set up the worktree exactly as the README says (plan id w1-1-chat-integrity, port 3011), then execute the plan with superpowers:executing-plans and TDD. Stay inside the owned files. When done, open a PR per the README rules.
```

## Why
- 44/50 testers lost a finished answer. `ChatEngine.tsx:233` does `finalContent = event.content` while `ceo.ts` streams `final_response` as **deltas**, so the saved/visible answer is the last token (e.g. `" advice.*"`). Hit on 56/80 crew turns.
- History is filtered by the lane that produced each message (`ChatEngine.tsx:137, 619–621, 687–689`). Discover sends no history and stores JSON. 13/13 scripted mode switches lost context; 11 testers were told an earlier answer never existed, and 12 of the 16 who got a denial quit.
- 34 testers asked for a Stop button. The composer stays locked for the whole run.

## Owned files
- `src/components/chat/ChatEngine.tsx`
- `src/components/chat/ChatInput.tsx`, `src/components/chat/GlobalComposer.tsx`
- `src/components/chat/MessageList.tsx`, `src/components/chat/DiscoverResult.tsx`
- `src/components/chat/Message.tsx`: **only** the VERDICT-card fill and the stopped state. W2-3 redesigns this file later.
- chat store (wherever `messagesOf`/`addMessage` live), `src/app/api/conversations/**`
- `src/app/chat/**` routing for the conversation id
- `src/types/chat.ts` (add fields only)

**Do not touch:** `src/agents/ceo.ts`, `src/app/api/chat/route.ts`, `ChatContainer.tsx` (W1-3); `src/lib/llm.ts`, `api/classify` (W1-2).

## Tasks
1. **Append, don't replace.** Accumulate `final_response` deltas into `finalContent`. Save the accumulated text. Check the other lanes (simple, discover, deep_research) and `deepen` for the same pattern. Regression test: feed a fake SSE stream of N deltas and assert the saved content equals their concatenation.
   - If the CEO sometimes emits a full, non-delta `final_response` (e.g. fallback or "couldn't compile" paths; see `ceo.test.ts`, `discovery.test.ts`), don't guess: add an explicit event field such as `{ type: "final_response", content, replace?: true }` in `types/chat.ts` and handle it. Coordinate with W1-3 through the PR description. W1-3 owns the emit side and adds `replace: true` there; until it lands, the client treats every event as a delta, which matches today's server behaviour.
2. **VERDICT card.** Fill it with the actual verdict sentence, not the disclaimer tail. Pick the first sentence of the verdict section. If none is found, hide the card; never show a fragment.
3. **One transcript.** Remove the per-mode history filters. Every lane gets the same ordered history: user and assistant turns, capped by a token budget with the newest turns kept. Add one helper `buildHistory(messages, budget)` with tests.
   - Save Discover results as **readable markdown text** (a ranked list with one-line reasons) in `content`. Keep the structured JSON in an `attachment` field used for rendering. Discover requests now send history too.
   - Old conversations in Firestore that stored JSON content: when loading, convert them to text for history (don't migrate data).
4. **Conversation id in the URL** (e.g. `/chat/[id]` or `?c=`, whichever fits the existing router; read the Next docs). Reloading restores the thread. Back/forward works.
5. **Persist** follow-up chips and the Second Opinion block with the message, so a reload shows the same thing.
6. **Stop button.** It replaces Send while a run streams. It aborts via the existing `streamAborters` controller. Keep the partial text and mark it "Stopped" (not an error). The composer unlocks right away. Other conversations keep streaming (per-conversation engine).
7. **No denial of earlier answers.** With (3) done this should stop happening. Add a test conversation: agent answer → simple follow-up "summarize what you just told me". Assert the history sent contains the agent answer.

## Acceptance
- Scripted switch suite (vitest, mocked fetch): agent→simple, simple→agent, discover→simple, discover→agent, deep→simple. Every follow-up payload contains the previous assistant content.
- Manual: in the browser, run one real crew answer (port 3011). The full report stays visible after streaming and after a reload. Stop mid-run keeps the partial text and unlocks the composer.
- typecheck, lint and tests are green.

## PR notes to include
- Whether you added `replace` to the `final_response` event, so W1-3 can mark its full-content emits.
