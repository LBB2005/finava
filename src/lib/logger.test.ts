import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRunContext, usageStore } from "./runContext";
import { logger } from "./logger";

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const spies = (["log", "warn", "error"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((s: unknown) => {
      lines.push(String(s));
    })
  );
  try {
    fn();
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return lines;
}

afterEach(() => vi.restoreAllMocks());

describe("logger", () => {
  it("emits a structured JSON line with level, tag, msg, and timestamp", () => {
    const [line] = capture(() => logger("test").info("hello", { foo: 1 }));
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ level: "info", tag: "test", msg: "hello", foo: 1 });
    expect(parsed.t).toBeTypeOf("string");
  });

  it("redacts sensitive keys but keeps benign ones", () => {
    const [line] = capture(() =>
      logger("t").info("x", { prompt: "secret user text", email: "a@b.com", ok: "visible" })
    );
    const p = JSON.parse(line);
    expect(p.prompt).toBe("[redacted]");
    expect(p.email).toBe("[redacted]");
    expect(p.ok).toBe("visible");
  });

  it("truncates long strings and collapses nested objects", () => {
    const [line] = capture(() =>
      logger("t").warn("x", { big: "a".repeat(500), obj: { nested: true } })
    );
    const p = JSON.parse(line);
    expect(p.big.length).toBeLessThan(210);
    expect(p.big.endsWith("…")).toBe(true);
    expect(p.obj).toBe("[object]");
  });

  it("stamps the requestId from the active run context", () => {
    const lines = capture(() =>
      usageStore.run(makeRunContext("u", "req-abc"), () => {
        logger("t").error("boom");
      })
    );
    expect(JSON.parse(lines[0]).requestId).toBe("req-abc");
  });

  it("routes error() to console.error and info() to console.log", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger("t").error("e");
    logger("t").info("i");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
