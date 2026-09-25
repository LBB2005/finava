# Clarify panel: design

**Date:** 2026-09-25 · **Branch:** `feat/clarify-panel`

## Problem

When Finava needs more before it can answer ("what should I buy?"), it posts the
question as an ordinary assistant bubble with bare chips. It reads as an answer,
the chips carry no explanation, and it can ask only one thing. The original
prompt is kept in a module-level `Map` in `ChatEngine.tsx`, so a reload between
question and answer loses it.

Liam wants the question to behave like Claude's: a panel docked at the composer,
answered in a click, with the chat showing only what was chosen.

## Decisions (agreed with Liam)

| Question | Decision |
|---|---|
| Which follow-ups move | **Clarifying questions only.** "Follow up with" chips under answers are unchanged. |
| Where | **Docked at the composer.** The panel replaces the input until answered or skipped. |
| How many | **1–3 questions**, tabbed when more than one. Each has 2–4 options with a one-line description, plus "Other…" free text. |
| Transcript | **Compact receipt line** under the user's message (`↳ Horizon: Long term · Amount: $1k–$10k`), or `↳ Skipped — answered with assumptions`. The question itself never renders as a bubble. |

When Finava asks is unchanged: the router's bias against clarifying and the
scout's vague-query gate stay as they are.

## Data

`src/lib/chat/clarify.ts` (pure, client-safe) owns the shapes and every rule:

```ts
interface ClarifyOption   { label: string; description?: string }
interface ClarifyQuestion { header: string; question: string; options: ClarifyOption[] }
interface ClarifyAnswer   { header: string; question: string; answer: string }
interface ClarifyReply    { answers: ClarifyAnswer[]; skipped: boolean }
```

- `cleanClarify(raw)` sanitises model or stored output: at most 3 questions,
  2–4 options each, trimmed and length-capped, duplicate and "Other" options
  dropped. It returns `null` when nothing usable is left. It also accepts the
  legacy `{clarifyQuestion, clarifyChips}` shape.
- `pendingClarifyOf(messages)` gives the open question set, derived from the
  transcript: the last message is an assistant message carrying `clarify`. It
  returns the questions, the original prompt (the user message before it) and
  that prompt's mode.
- `foldClarification(originalPrompt, reply)` builds the lane prompt: the original
  plus the answers, or plus a skip instruction to answer with stated assumptions.
- `replyContent(reply)` and `receiptText(reply)` give the history text and the
  receipt line.

`ChatMessage` gains `clarify?: ClarifyQuestion[]` (assistant) and
`clarifyReply?: ClarifyReply` (user). Both persist through the messages API
(zod-validated, stored natively in Firestore) and are re-cleaned on load. Because
the pending state is derived from persisted messages, it **survives reload**, and
the module-level `pendingClarify` Map is deleted.

## Flow

1. **Router** (`intent.ts`): the prompt asks for
   `{"intent":"clarify","clarify":[{header,question,options:[{label,description}]}]}`.
   `resolveIntent` returns `clarify: ClarifyQuestion[]` in place of
   `clarifyQuestion/clarifyChips`. The existing suppression rules are untouched.
   The classify route's `maxTokens` rises from 200 to 600 so three questions fit.
2. **Scout** (`scout-agent.ts`): `discover_clarify` carries `questions` with
   described options. "A specific sector" is dropped because "Other…" covers it.
3. **ChatEngine**: both lanes commit the question as an assistant message with
   `clarify` set and `content` = the question text (so history stays readable),
   then stop.
4. **GlobalComposer**: on `/chat`, when the viewed conversation has a pending
   clarify and isn't streaming, it renders `ClarifyPanel` in place of `ChatInput`.
5. **Answer or Skip**: the panel enqueues a send with `clarifyReply`, the mode of
   the original prompt and `text = replyContent(reply)`. `processSend` sees the
   pending clarify in `prior`, folds the lane prompt, stamps `clarifyReply` on the
   user message, and runs the lane with clarify disabled. That covers both Auto
   and the Discover scout, so the user is never asked twice.

## UI

- **`ClarifyPanel.tsx`**: same 720px column and frosted surface as the composer.
  It has a header ("Finava needs one thing" / "…a few things"), a tab strip only
  when there are 2 or more questions (✓ answered, current highlighted), and
  option rows with a bold label and a muted description. The last row is "Other…",
  which reveals a `.std-focus` text input. Controls are Skip and Next →, which
  becomes Go → on the last question.
- **Keyboard**: 1–4 picks an option, ←/→ switches tabs, Enter advances. Esc does
  nothing, so nobody skips by accident.
- **Motion**: a 200 ms fade and rise, which `prefers-reduced-motion` disables.
- **Styling**: tokens only, `.std-focus`, no literal colours.
- **Message.tsx**: an assistant message with `clarify` renders nothing. A user
  message with `clarifyReply` renders as the muted receipt line, pulled up under
  the prompt above it. MessageList is untouched, because open PR #22 rewrites it.

## Error handling

- The router returns malformed clarify data → `cleanClarify` returns null → the
  lane falls back to fast or discover (existing rule).
- The send fails → the existing retry toast. The panel reappears because the
  pending state is derived from the transcript.
- A legacy clarify message with no `clarify` field → it renders as before, with
  chips and no panel.

## Testing

- **Vitest**: `clarify.test.ts` covers clean, pending, fold, receipt and legacy
  shapes. `intent.test.ts` is updated for the new shape. `storedMessage.test.ts`
  covers round-tripping `clarify` and `clarifyReply`. The messages route test
  covers the new fields.
- **Browser**: in the dev preview, "what should I buy?" in Auto shows the panel.
  Answering shows the receipt and then the answer. A reload mid-question restores
  the panel.
