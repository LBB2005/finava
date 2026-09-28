import { beforeEach, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({
  docs: new Map<string, unknown>(),
  fail: false,
  commits: 0,
}));
vi.mock("../firebase-admin", () => {
  const ref = (path: string) => ({
    path,
    collection: (key: string) => collection(`${path}/${key}`),
    get: async () => ({
      exists: state.docs.has(path),
      data: () => structuredClone(state.docs.get(path)),
    }),
  });
  const collection = (path: string) => ({
    doc: (key: string) => ref(`${path}/${key}`),
  });
  return {
    db: {
      collection,
      batch: () => {
        const writes: { path: string; value: unknown }[] = [];
        return {
          create: (r: { path: string }, value: unknown) => {
            writes.push({ path: r.path, value });
          },
          commit: async () => {
            state.commits++;
            if (state.fail) throw new Error("simulated atomic write failure");
            if (writes.some((w) => state.docs.has(w.path)))
              throw Object.assign(new Error("exists"), { code: 6 });
            for (const w of writes)
              state.docs.set(w.path, structuredClone(w.value));
          },
        };
      },
    },
  };
});
import { firestoreTournamentJournal } from "./ledgerTournament";
beforeEach(() => {
  state.docs.clear();
  state.fail = false;
  state.commits = 0;
});
it("commits chunks and metadata atomically, with no poisoned checkpoint on retry", async () => {
  const journal = await firestoreTournamentJournal("tournament_dryrun");
  state.fail = true;
  await expect(journal.create("started", { at: "first" })).rejects.toThrow(
    /atomic/,
  );
  expect(await journal.get("started")).toBeNull();
  expect(state.docs.size).toBe(0);
  state.fail = false;
  await journal.create("started", { at: "second" });
  expect(await journal.get("started")).toEqual({ at: "second" });
  await journal.create("started", { at: "second" });
  await expect(journal.create("started", { at: "third" })).rejects.toThrow(
    /conflict/,
  );
});
it("verifies multi-document checkpoints and bounds transaction size", async () => {
  const journal = await firestoreTournamentJournal("tournament_dryrun"),
    value = { text: "a".repeat(300001) };
  await journal.create("snapshot", value);
  expect(await journal.get("snapshot")).toEqual(value);
  expect(state.docs.size).toBe(4);
  await expect(
    journal.create("too-big", "a".repeat(9 * 1024 * 1024)),
  ).rejects.toThrow(/8 MiB/);
  expect(state.commits).toBe(1);
  const part = [...state.docs.keys()].find((k) => k.endsWith("_0"))!;
  state.docs.set(part, { text: "tampered" });
  await expect(journal.get("snapshot")).rejects.toThrow();
});
