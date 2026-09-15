import { describe, expect, it } from "vitest";
import { RunRegistry, stoppedMessage } from "./runControl";
import { emptySlice } from "@/stores/chatStore";

describe("RunRegistry", () => {
  it("stop aborts the run, marks it stopped and frees the conversation", () => {
    const runs = new RunRegistry();
    const ctrl = runs.start("c1");
    expect(runs.stop("c1")).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
    expect(runs.wasStopped(ctrl)).toBe(true);
    expect(runs.get("c1")).toBeUndefined();
    expect(runs.stop("c1")).toBe(false);
  });

  it("a stale run's finish does not clear a newer run on the same conversation", () => {
    const runs = new RunRegistry();
    const old = runs.start("c1");
    runs.stop("c1");
    const next = runs.start("c1");
    expect(runs.finish("c1", old)).toBe(false);
    expect(runs.get("c1")).toBe(next);
    expect(runs.finish("c1", next)).toBe(true);
    expect(runs.get("c1")).toBeUndefined();
  });

  it("cancel aborts without marking stopped (e.g. chat deleted)", () => {
    const runs = new RunRegistry();
    const ctrl = runs.start("c1");
    runs.cancel("c1");
    expect(ctrl.signal.aborted).toBe(true);
    expect(runs.wasStopped(ctrl)).toBe(false);
  });

  it("other conversations keep running", () => {
    const runs = new RunRegistry();
    const a = runs.start("a");
    const b = runs.start("b");
    runs.stop("a");
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(runs.isCurrent("b", b)).toBe(true);
  });
});

describe("stoppedMessage", () => {
  it("keeps the partial text, trace and critique, flagged stopped", () => {
    const slice = {
      ...emptySlice(),
      isStreaming: true,
      streamingContent: "## Summary\nNVDA looks",
      agentSteps: [{ agent: "run_dcf_agent" as const, status: "complete" as const }],
      pendingCritique: "thin data",
    };
    const m = stoppedMessage(slice, "agent", 4200);
    expect(m).toMatchObject({
      role: "assistant",
      content: "## Summary\nNVDA looks",
      mode: "agent",
      stopped: true,
      critique: "thin data",
      durationMs: 4200,
    });
    expect(m.agentTrace).toHaveLength(1);
  });

  it("still produces a stopped marker when no text had arrived", () => {
    const m = stoppedMessage({ ...emptySlice(), isStreaming: true }, "simple");
    expect(m.content).toBe("");
    expect(m.stopped).toBe(true);
    expect(m.agentTrace).toBeUndefined();
  });
});
