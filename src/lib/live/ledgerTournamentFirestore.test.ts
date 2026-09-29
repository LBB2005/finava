import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { TournamentBatch } from "../tournament/types";

// Replace only the external database. Reject oversized documents and enforce
// atomic create-only transactions so publication uses the real ledger code.
const state = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  failTransaction: false,
  transactions: [] as string[][],
}));
vi.mock("../firebase-admin", () => {
  type Write = { path: string; value: Record<string, unknown>; create: boolean };
  const snapshot = (path: string) => ({
    exists: state.docs.has(path),
    data: () => structuredClone(state.docs.get(path)),
  });
  const commit = (writes: Write[]) => {
    if (writes.length > 500) throw new Error("Firestore 500 writes limit");
    let bytes = 0;
    for (const write of writes) {
      const size = Buffer.byteLength(JSON.stringify(write.value));
      if (size > 1024 * 1024) throw new Error("Firestore 1 MiB document limit");
      bytes += size;
      if (write.create && state.docs.has(write.path))
        throw Object.assign(new Error("already exists"), { code: 6 });
    }
    if (bytes > 10 * 1024 * 1024) throw new Error("Firestore 10 MiB request limit");
    for (const write of writes)
      state.docs.set(write.path, structuredClone(write.value));
  };
  const ref = (path: string) => ({
    path,
    collection: (name: string) => collection(`${path}/${name}`),
    get: async () => snapshot(path),
    create: async (value: Record<string, unknown>) =>
      commit([{ path, value, create: true }]),
  });
  const collection = (path: string) => {
    const query = (field?: string, value?: unknown, order?: string) => ({
      get: async () => {
        const entries = [...state.docs.entries()].filter(([key, data]) =>
          key.startsWith(`${path}/`) &&
          !key.slice(path.length + 1).includes("/") &&
          (!field || data[field] === value),
        );
        if (order) entries.sort((a, b) => String(a[1][order]).localeCompare(String(b[1][order])));
        return { docs: entries.map(([key]) => ({ ...snapshot(key), ref: ref(key) })) };
      },
    });
    return {
      doc: (name: string) => ref(`${path}/${name}`),
      get: query().get,
      orderBy: (field: string) => query(undefined, undefined, field),
      where: (field: string, operator: string, value: unknown) => {
        if (operator !== "==") throw new Error("Unsupported query");
        return query(field, value);
      },
    };
  };
  return { db: {
    collection,
    runTransaction: async (work: (tx: unknown) => Promise<void>) => {
      const writes: Write[] = [];
      await work({
        get: async (r: { path: string }) => snapshot(r.path),
        create: (r: { path: string }, value: Record<string, unknown>) =>
          writes.push({ path: r.path, value, create: true }),
        set: (r: { path: string }, value: Record<string, unknown>) =>
          writes.push({ path: r.path, value, create: false }),
      });
      if (state.failTransaction) throw new Error("simulated atomic publication failure");
      commit(writes);
      state.transactions.push(writes.map((w) => w.path));
    },
  } };
});
import { firestoreTournamentLedger, makeBatch, verifyBatches } from "./ledgerTournament";
import { fixtureSnapshot, fixtureSessions } from "../tournament/fixtures";
import { makePrediction } from "../tournament/predictions";
import { sessionWindow } from "../marketCalendar";
const root = "tournament_dryrun/ledger";
function fixture(count = 20120) {
  const snapshot = fixtureSnapshot();
  const template = makePrediction({
    snapshot,
    arm: "growth",
    ticker: "T1",
    rank: 1,
    decile: 10,
    disposition: "long",
    horizon: 1,
    window: sessionWindow(fixtureSessions(), snapshot.asOf.slice(0, 10), 1),
    codeSha: "a".repeat(40),
    registrationHash: "b".repeat(64),
    createdAt: snapshot.observedAt,
  });
  const rows = Array.from({ length: count }, (_, index) => {
    const id = createHash("sha256").update(`prediction-${index}`).digest("hex");
    return { ...template, id, prediction: { ...template.prediction, id } };
  });
  const batch = makeBatch(rows, null, {
    date: template.date,
    asOf: snapshot.asOf,
    createdAt: snapshot.observedAt,
    codeSha: template.codeSha,
    registrationHash: template.registrationHash,
    snapshotHash: template.snapshotHash,
    namespace: "tournament_dryrun",
  });
  return { rows, batch };
}
const full = fixture();
function chunkPaths(batch: TournamentBatch) {
  return [...state.docs.keys()].filter((key) => key.startsWith(`${root}/batches/${batch.date}/`));
}
beforeEach(() => {
  state.docs.clear();
  state.failTransaction = false;
  state.transactions = [];
});
it("publishes all 20,120 SHA prediction IDs within Firestore limits and returns the exact canonical batch", async () => {
  const ledger = await firestoreTournamentLedger("tournament_dryrun");
  expect(Buffer.byteLength(JSON.stringify(full.batch))).toBeGreaterThan(1024 * 1024);
  await expect(ledger.appendBatch(full.batch, full.rows)).resolves.toBe("created");
  const [batch] = await ledger.listBatches();
  expect(batch).toEqual(full.batch);
  expect((await ledger.rows(batch.date)).length).toBe(20120);
  expect(verifyBatches([{ batch, rows: full.rows }])).toEqual({ valid: true, reason: null });
  const chunks = chunkPaths(batch);
  expect(chunks.length).toBeGreaterThan(1);
  expect(state.transactions).toHaveLength(1);
  expect(state.transactions[0]).toEqual(expect.arrayContaining([
    `${root}/batches/${batch.date}`, `${root}/state/head`, ...chunks,
  ]));
  const digest = () => createHash("sha256").update(JSON.stringify([...state.docs])).digest("hex");
  const before = digest();
  await expect(ledger.appendBatch(full.batch, full.rows)).resolves.toBe("duplicate");
  expect(digest()).toBe(before);
});
it("reads existing inline batches without adding storage fields or rewriting history", async () => {
  const { batch } = fixture(2);
  state.docs.set(`${root}/batches/${batch.date}`, structuredClone(batch) as unknown as Record<string, unknown>);
  const ledger = await firestoreTournamentLedger("tournament_dryrun");
  expect(await ledger.listBatches()).toEqual([batch]);
  expect(state.docs.size).toBe(1);
});
it("keeps chunks and the head unpublished on failure and resumes identical rows with original metadata", async () => {
  const { batch, rows } = fixture(2001);
  const ledger = await firestoreTournamentLedger("tournament_dryrun");
  state.failTransaction = true;
  await expect(ledger.appendBatch(batch, rows)).rejects.toThrow(/atomic publication/);
  expect(await ledger.listBatches()).toEqual([]);
  expect(chunkPaths(batch)).toEqual([]);
  expect(state.docs.has(`${root}/state/head`)).toBe(false);
  expect((await ledger.rows(batch.date)).length).toBe(2001);
  state.failTransaction = false;
  await expect(ledger.appendBatch(batch, rows)).resolves.toBe("created");
  expect(await ledger.listBatches()).toEqual([batch]);
  const changed = { ...batch, createdAt: "2026-07-02T21:01:00.000Z" };
  await expect(ledger.appendBatch(changed, rows)).rejects.toThrow(/append-only conflict/);
});
it.each(["missing", "content", "order", "index"])("rejects %s row-ID chunk corruption during batch reads", async (kind) => {
  const ledger = await firestoreTournamentLedger("tournament_dryrun");
  const {batch,rows}=fixture(2001);
  await ledger.appendBatch(batch, rows);
  const path = chunkPaths(batch)[0];
  expect(path).toBeDefined();
  if (kind === "missing") state.docs.delete(path);
  else {
    const chunk = state.docs.get(path)!;
    const rowIds = [...chunk.rowIds as string[]];
    if (kind === "content") rowIds[0] = "f".repeat(64);
    else if (kind === "order") [rowIds[0], rowIds[1]] = [rowIds[1], rowIds[0]];
    state.docs.set(path, { ...chunk, rowIds, index: kind === "index" ? -1 : chunk.index });
  }
  await expect(ledger.listBatches()).rejects.toThrow(/row.ID|chunk|integrity/i);
});

it("rejects an oversized publication before creating any prediction rows", async () => {
  const { rows, batch: original } = fixture(1);
  const codeSha = "x".repeat(1024 * 1024);
  rows[0] = { ...rows[0], codeSha };
  const batch = makeBatch(rows, null, { ...original, codeSha });
  const ledger = await firestoreTournamentLedger("tournament_dryrun");
  await expect(ledger.appendBatch(batch, rows)).rejects.toThrow(/safe atomic Firestore limits/);
  expect(state.docs.size).toBe(0);
});
