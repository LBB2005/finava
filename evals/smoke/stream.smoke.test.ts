/**
 * Smoke: the answer a user keeps is the answer the server streamed.
 *
 * Every fixture is replayed through the functions ChatEngine calls
 * (`streamAgent` / `streamSimple` → `collectAgentStream` / `collectChatStream` →
 * `applyFinalResponse`), cut at several byte boundaries. The saved text must equal
 * the fixture's `.expected.md`, which was written from the source text rather than
 * produced by a reducer. The Sep-14 collapse (`finalContent = event.content`)
 * cannot pass this.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { agentBody, simpleChatBody, streamAgent, streamSimple, type Fetcher } from "@/lib/chat/requests";
import { useChatStore } from "@/stores/chatStore";
import type { AgentEvent } from "@/types/chat";
import { fixtureResponse, listFixtures, loadFixture, wireEvents } from "../lib/replay";

const SEEDS = [0, 1, 7, 42, 1337];

function fetcherFor(name: string, seed: number): Fetcher {
  return async () => fixtureResponse(loadFixture(name), seed);
}

const s = () => useChatStore.getState();

beforeEach(() => {
  useChatStore.setState({ streamsByConv: {}, messagesByConv: {} });
});

describe.each(listFixtures())("fixture %s", (name) => {
  const fx = loadFixture(name);

  it.each(SEEDS)("saves the whole answer (chunk seed %i)", async (seed) => {
    const fetcher = fetcherFor(name, seed);
    if (fx.route === "agent") {
      const events: AgentEvent[] = [];
      const saved = await streamAgent(
        fetcher,
        agentBody({ prior: [], text: "q", portfolioContext: "", deepResearch: false, holdings: [] }),
        { onEvent: (e) => events.push(e) }
      );
      expect(saved).toBe(fx.expected);
      // Every wire event reached the handler, in order: nothing dropped at a chunk boundary.
      expect(events.map((e) => e.type)).toEqual(
        wireEvents(fx.bytes).map((e) => (e as { type: string }).type)
      );
    } else {
      // The fast lane's wiring in ChatEngine.runSimpleChat: every text delta goes
      // to the store (what renders), the return value is what gets committed.
      const convId = `smoke-${name}-${seed}`;
      const saved = await streamSimple(fetcher, simpleChatBody({ prior: [], text: "q", portfolioContext: "" }), {
        onText: (t) => s().appendStreamChunk(convId, t),
        onFollowups: (q) => s().setPendingFollowups(convId, q),
      });
      expect(saved).toBe(fx.expected);
      expect(s().slice(convId).streamingContent).toBe(saved);
    }
  });

  it("is not a trivially short answer (a fixture that could hide a collapse)", () => {
    expect(fx.expected.length).toBeGreaterThan(80);
  });
});

describe("the streamed crew revision (the Sep-14 collapse path)", () => {
  it("saved text is the concatenation of every delta, not the last one", async () => {
    const fx = loadFixture("agent-crew-streamed-revision");
    const deltas = wireEvents(fx.bytes)
      .filter((e): e is { type: string; content: string } => (e as { type?: string }).type === "final_response")
      .map((e) => e.content);
    expect(deltas.length).toBeGreaterThan(20);

    const saved = await streamAgent(
      fetcherFor(fx.name, 3),
      agentBody({ prior: [], text: "q", portfolioContext: "", deepResearch: false, holdings: [] }),
      { onEvent: () => {} }
    );
    expect(saved).toBe(deltas.join(""));
    expect(saved!.length).toBeGreaterThan(deltas.at(-1)!.length * 10);
  });
});

describe("ChatEngine never assigns a final_response over the text so far", () => {
  // The replay above covers the shared reducer. This covers ChatEngine's own
  // inline handlers (the store path and the discover lanes), which a test cannot
  // mount without a browser. `x = event.content` is exactly how :233 was written.
  const src = readFileSync(path.join(__dirname, "../../src/components/chat/ChatEngine.tsx"), "utf8");

  it("has no `= event.content` assignment", () => {
    expect(src).not.toMatch(/\b\w+\s*=\s*event\.content\b/);
  });

  it("clears the rendered text only for a replace event", () => {
    const handler = src.slice(src.indexOf('case "final_response":'));
    const body = handler.slice(0, handler.indexOf("break;"));
    expect(body).toMatch(/if\s*\(\s*event\.replace\s*\)\s*st\.clearStreamingContent/);
    expect(body).toMatch(/st\.appendStreamChunk\(convId,\s*event\.content\)/);
  });

  it("builds every lane's answer through the shared stream helpers", () => {
    expect(src).toMatch(/from "@\/lib\/chat\/stream"/);
    expect(src).toMatch(/from "@\/lib\/chat\/requests"/);
    expect(src).toMatch(/applyFinalResponse\(framing, event\)/);
    expect(src).toMatch(/applyFinalResponse\(report, event\)/);
  });
});
