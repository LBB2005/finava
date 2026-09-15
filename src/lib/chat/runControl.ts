import type { StreamSlice } from "@/stores/chatStore";
import type { ChatMessage, ChatMode } from "@/types/chat";

/**
 * One AbortController per in-flight conversation run. The controller doubles as
 * the run's identity: a run that was stopped or replaced must not touch the
 * conversation's state when it finally unwinds, because a newer run may own it.
 */
export class RunRegistry {
  private runs = new Map<string, AbortController>();
  private stopped = new WeakSet<AbortController>();

  start(convId: string): AbortController {
    const ctrl = new AbortController();
    this.runs.set(convId, ctrl);
    return ctrl;
  }

  get(convId: string): AbortController | undefined {
    return this.runs.get(convId);
  }

  isCurrent(convId: string, ctrl: AbortController | undefined): boolean {
    return !!ctrl && this.runs.get(convId) === ctrl;
  }

  /** Release the conversation if `ctrl` still owns it. Returns whether it did. */
  finish(convId: string, ctrl: AbortController | undefined): boolean {
    if (!this.isCurrent(convId, ctrl)) return false;
    this.runs.delete(convId);
    return true;
  }

  /** The user pressed Stop. Returns false when nothing was running. */
  stop(convId: string): boolean {
    const ctrl = this.runs.get(convId);
    if (!ctrl) return false;
    this.stopped.add(ctrl);
    this.runs.delete(convId);
    ctrl.abort();
    return true;
  }

  /** Abort without the stopped semantics (e.g. the conversation was deleted). */
  cancel(convId: string): void {
    this.runs.get(convId)?.abort();
    this.runs.delete(convId);
  }

  wasStopped(ctrl: AbortController | undefined): boolean {
    return !!ctrl && this.stopped.has(ctrl);
  }
}

/** The assistant message a stopped run leaves behind: whatever had streamed so far. */
export function stoppedMessage(slice: StreamSlice, mode: ChatMode, durationMs?: number): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: slice.streamingContent,
    mode,
    createdAt: new Date().toISOString(),
    agentTrace: slice.agentSteps.length ? slice.agentSteps : undefined,
    critique: slice.pendingCritique || undefined,
    followups: slice.pendingFollowups.length ? slice.pendingFollowups : undefined,
    durationMs,
    stopped: true,
  };
}
