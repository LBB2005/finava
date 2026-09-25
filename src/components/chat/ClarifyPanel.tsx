"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ClarifyQuestion, ClarifyReply } from "@/lib/chat/clarify";

/** The parts of a key event the panel reads — React's or the window's. */
type KeyLike = { key: string; target: EventTarget | null; preventDefault(): void };

/** One question's state: a picked option, or free text from the "Other…" row. */
type Choice = { option: number } | { other: string };

const OTHER = -1;
const MAX_OTHER = 500;

function answerOf(q: ClarifyQuestion, pick: Choice | undefined): string {
  if (!pick) return "";
  return "option" in pick ? q.options[pick.option]?.label ?? "" : pick.other.trim();
}

/**
 * Clarifying questions, docked where the composer sits (it takes the composer's
 * place until answered). One click answers a question; answering the last one
 * sends. "Other…" takes free text. Skip answers anyway with stated assumptions.
 *
 * Keys: 1–4 pick, ←/→ switch questions, Enter moves on. Esc does nothing, so a
 * stray keypress never throws the questions away.
 */
export default function ClarifyPanel({
  questions,
  onSubmit,
}: {
  questions: ClarifyQuestion[];
  onSubmit: (reply: ClarifyReply) => void;
}) {
  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState<(Choice | undefined)[]>(() => questions.map(() => undefined));
  const [otherOpen, setOtherOpen] = useState<boolean[]>(() => questions.map(() => false));
  const sentRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);

  const q = questions[index];
  const multi = questions.length > 1;
  const isLast = index === questions.length - 1;
  const current = picks[index];
  const answered = (i: number) => answerOf(questions[i], picks[i]).length > 0;

  // The panel is taller than the composer: widen the transcript's bottom
  // clearance while it's up so the prompt it's asking about stays in view.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = rootRef.current;
    if (!el) return;
    const prev = root.style.getPropertyValue("--content-pad-bottom");
    const apply = () => root.style.setProperty("--content-pad-bottom", `${el.offsetHeight + 36}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    const scroller = document.querySelector(".print-transcript");
    requestAnimationFrame(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
    return () => {
      ro.disconnect();
      if (prev) root.style.setProperty("--content-pad-bottom", prev);
      else root.style.removeProperty("--content-pad-bottom");
    };
  }, []);

  // Keys work straight away, and keep working after a click swaps the options
  // out from under the focused button: focus returns to the panel (or to the
  // "Other…" input when that's open) whenever the question changes.
  useEffect(() => {
    if (otherOpen[index]) otherRef.current?.focus();
    else rootRef.current?.focus({ preventScroll: true });
  }, [index, otherOpen]);

  // Focus can still land on <body> (a click on the page, a re-render). Keys
  // pressed there belong to the panel; keys pressed anywhere else don't.
  const keyRef = useRef<(e: KeyLike) => void>(() => {});
  useEffect(() => {
    const onWindowKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      keyRef.current(e);
    };
    window.addEventListener("keydown", onWindowKey);
    return () => window.removeEventListener("keydown", onWindowKey);
  }, []);

  function send(next: (Choice | undefined)[]) {
    if (sentRef.current) return;
    sentRef.current = true;
    onSubmit({
      skipped: false,
      answers: questions.map((qq, i) => ({ header: qq.header, question: qq.question, answer: answerOf(qq, next[i]) })),
    });
  }

  function skip() {
    if (sentRef.current) return;
    sentRef.current = true;
    onSubmit({ skipped: true, answers: [] });
  }

  /** After an answer: the next unanswered question, or send once all are in. */
  function advance(next: (Choice | undefined)[]) {
    const open = questions.findIndex((qq, i) => i !== index && !answerOf(qq, next[i]));
    if (open === -1) send(next);
    else setIndex(open);
  }

  function choose(option: number) {
    if (option === OTHER) {
      setOtherOpen((o) => o.map((v, i) => (i === index ? true : v)));
      setPicks((p) => p.map((v, i) => (i === index ? { other: v && "other" in v ? v.other : "" } : v)));
      return;
    }
    const next = picks.map((v, i) => (i === index ? { option } : v));
    setPicks(next);
    setOtherOpen((o) => o.map((v, i) => (i === index ? false : v)));
    advance(next);
  }

  function next() {
    if (!answered(index)) return;
    if (isLast && questions.every((_, i) => answered(i))) send(picks);
    else advance(picks);
  }

  function onKeyDown(e: KeyLike) {
    const target = e.target as HTMLElement;
    const typing = target instanceof HTMLInputElement;
    if (e.key === "Enter") {
      // A focused button handles its own Enter (pick, switch, skip, go).
      if (target instanceof HTMLButtonElement) return;
      e.preventDefault();
      next();
      return;
    }
    if (typing) return;
    if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key) - 1;
      if (n < q.options.length) { e.preventDefault(); choose(n); }
      else if (n === q.options.length) { e.preventDefault(); choose(OTHER); }
    } else if (e.key === "ArrowRight" && multi) {
      e.preventDefault();
      setIndex((i) => Math.min(questions.length - 1, i + 1));
    } else if (e.key === "ArrowLeft" && multi) {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    }
  }
  useEffect(() => { keyRef.current = onKeyDown; });

  const otherActive = otherOpen[index];
  const otherText = current && "other" in current ? current.other : "";

  return (
    <div className="px-6 pt-5 pb-0 pointer-events-none">
      <div className="mx-auto max-w-[720px] pointer-events-auto">
        <div
          ref={rootRef}
          tabIndex={-1}
          role="group"
          aria-label="Finava has a question before it answers"
          onKeyDown={onKeyDown}
          className="clarify-panel"
        >
          <div className="clarify-head">
            <span className="eyebrow-label" style={{ color: "var(--color-accent)" }}>
              {multi ? "Finava needs a few things" : "Finava needs one thing"}
            </span>
            {multi && (
              <div className="clarify-tabs" role="tablist" aria-label="Questions">
                {questions.map((qq, i) => {
                  const done = answered(i);
                  return (
                    <button
                      key={i}
                      role="tab"
                      aria-selected={i === index}
                      onClick={() => setIndex(i)}
                      className={`clarify-tab std-focus${i === index ? " on" : ""}${done ? " done" : ""}`}
                    >
                      {done ? "✓ " : ""}{qq.header}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <p className="clarify-question">{q.question}</p>

          <div role="radiogroup" aria-label={q.question} className="clarify-options">
            {q.options.map((opt, i) => {
              const on = !!current && "option" in current && current.option === i;
              return (
                <button
                  key={opt.label}
                  role="radio"
                  aria-checked={on}
                  onClick={() => choose(i)}
                  className={`clarify-option std-focus${on ? " on" : ""}`}
                >
                  <span className="clarify-key" aria-hidden>{i + 1}</span>
                  <span className="clarify-option-text">
                    <span className="clarify-label">{opt.label}</span>
                    {opt.description && <span className="clarify-desc">{opt.description}</span>}
                  </span>
                </button>
              );
            })}

            <div
              role="radio"
              aria-checked={otherActive}
              tabIndex={otherActive ? -1 : 0}
              onClick={() => !otherActive && choose(OTHER)}
              onKeyDown={(e) => { if (!otherActive && (e.key === " " || e.key === "Enter")) { e.preventDefault(); e.stopPropagation(); choose(OTHER); } }}
              className={`clarify-option std-focus${otherActive ? " on" : ""}`}
            >
              <span className="clarify-key" aria-hidden>{q.options.length + 1}</span>
              <span className="clarify-option-text">
                {otherActive ? (
                  <input
                    ref={otherRef}
                    value={otherText}
                    maxLength={MAX_OTHER}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPicks((p) => p.map((x, i) => (i === index ? { other: v } : x)));
                    }}
                    placeholder="Type your own answer"
                    aria-label="Your own answer"
                    className="clarify-other-input"
                  />
                ) : (
                  <span className="clarify-label">Other…</span>
                )}
              </span>
            </div>
          </div>

          <div className="clarify-foot">
            <span className="clarify-hint" aria-hidden>
              {`1–${q.options.length + 1} to pick${multi ? " · ←/→ to switch" : ""}`}
            </span>
            <button onClick={skip} className="clarify-skip std-focus">
              Skip
            </button>
            <button onClick={next} disabled={!answered(index)} className="clarify-go std-focus">
              {isLast && questions.every((_, i) => i === index || answered(i)) ? "Go →" : "Next →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
