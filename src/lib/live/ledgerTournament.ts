// All tournament ledger writes live here. Create-only immutable rows, separately
// sealed daily batches, grades and portfolio marks; mutable locks never overwrite
// published data. Firestore rows are separate docs (20k rows exceed 1 MiB).
import { canonicalJson, hashEntry } from "./ledgerHash";
import { CHAIN_GENESIS } from "./ledgerCollections";
import type {
  Namespace,
  TournamentBatch,
  TournamentRow,
  TournamentGrade,
  PaperSnapshot,
  TournamentLedger,
} from "../tournament/types";
import type { Journal } from "../tournament/runtime";
import { randomUUID } from "node:crypto";
const sorted = (rows: TournamentRow[]) =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id));
export function makeBatch(
  rows: TournamentRow[],
  prior: TournamentBatch | null,
  meta: Pick<
    TournamentBatch,
    | "date"
    | "asOf"
    | "createdAt"
    | "codeSha"
    | "registrationHash"
    | "snapshotHash"
    | "namespace"
  >,
): TournamentBatch {
  const payload = {
    date: meta.date,
    asOf: meta.asOf,
    createdAt: meta.createdAt,
    codeSha: meta.codeSha,
    registrationHash: meta.registrationHash,
    snapshotHash: meta.snapshotHash,
    namespace: meta.namespace,
    rowIds: sorted(rows).map((r) => r.id),
    previousDate: prior?.date ?? null,
  };
  const previousHash = prior?.hash ?? CHAIN_GENESIS;
  return {
    ...payload,
    previousHash,
    hash: hashEntry({ ...payload, rows: sorted(rows) }, previousHash),
  };
}
export function verifyBatches(
  items: { batch: TournamentBatch; rows: TournamentRow[] }[],
): { valid: boolean; reason: string | null } {
  let prior: TournamentBatch | null = null;
  for (const { batch, rows } of [...items].sort((a, b) =>
    a.batch.date.localeCompare(b.batch.date),
  )) {
    if (prior && batch.date <= prior.date)
      return { valid: false, reason: "Duplicate or out-of-order day" };
    const expected = makeBatch(rows, prior, batch);
    if (canonicalJson(expected) !== canonicalJson(batch))
      return { valid: false, reason: `Hash chain mismatch on ${batch.date}` };
    prior = batch;
  }
  return { valid: true, reason: null };
}
function validateBatch(
  batch: TournamentBatch,
  rows: TournamentRow[],
  prior: TournamentBatch | null,
) {
  if (!rows.length || new Set(rows.map((r) => r.id)).size !== rows.length)
    throw new Error("Empty or duplicate prediction rows");
  if (prior && batch.date <= prior.date)
    throw new Error("Cannot insert a past batch into the chain");
  if (canonicalJson(makeBatch(rows, prior, batch)) !== canonicalJson(batch))
    throw new Error("Hash chain mismatch");
  for (const r of rows) {
    const entry = r.prediction.evaluationWindow?.entryAt;
    if (
      !entry ||
      Date.parse(r.prediction.createdAt) >= Date.parse(entry) ||
      Date.parse(batch.createdAt) >= Date.parse(entry)
    )
      throw new Error("Predictions must be sealed before entry open");
    if (
      r.id !== r.prediction.id ||
      r.date !== batch.date ||
      r.snapshotHash !== batch.snapshotHash ||
      r.registrationHash !== batch.registrationHash ||
      r.codeSha !== batch.codeSha ||
      r.prediction.asOf !== batch.asOf
    )
      throw new Error("Prediction provenance does not match batch");
  }
}
export class MemoryTournamentLedger implements TournamentLedger {
  private batches = new Map<string, TournamentBatch>();
  private records = new Map<string, TournamentRow[]>();
  private marks = new Map<string, TournamentGrade>();
  private books = new Map<string, PaperSnapshot>();
  async listBatches() {
    return structuredClone(
      [...this.batches.values()].sort((a, b) => a.date.localeCompare(b.date)),
    );
  }
  async rows(date: string) {
    return structuredClone(this.records.get(date) ?? []);
  }
  async appendBatch(batch: TournamentBatch, rows: TournamentRow[]) {
    const previous = [...this.batches.values()].at(-1) ?? null;
    if (this.batches.has(batch.date)) {
      if (
        canonicalJson(this.batches.get(batch.date)) !== canonicalJson(batch) ||
        canonicalJson(sorted(this.records.get(batch.date)!)) !==
          canonicalJson(sorted(rows))
      )
        throw new Error("append-only conflict");
      return "duplicate" as const;
    }
    validateBatch(batch, rows, previous);
    this.batches.set(batch.date, structuredClone(batch));
    this.records.set(batch.date, structuredClone(rows));
    return "created" as const;
  }
  async grades() {
    return structuredClone([...this.marks.values()]);
  }
  async appendGrade(g: TournamentGrade) {
    if (this.marks.has(g.id)) throw new Error("append-only conflict");
    this.marks.set(g.id, structuredClone(g));
  }
  async portfolios() {
    return structuredClone([...this.books.values()]);
  }
  async appendPortfolio(p: PaperSnapshot) {
    if (this.books.has(p.id)) throw new Error("append-only conflict");
    this.books.set(p.id, structuredClone(p));
  }
  update(): never {
    throw new Error("Tournament ledger is append-only");
  }
  delete(): never {
    throw new Error("Tournament ledger is append-only");
  }
}

const BATCH_ROW_IDS_PER_CHUNK = 2000;
type BatchRowIdChunk = { index: number; rowIds: string[] };
type StoredTournamentBatch = Omit<TournamentBatch, "rowIds"> & {
  rowIdStorage: {
    version: 1;
    count: number;
    chunks: number;
    hash: string;
  };
};

function batchPublication(batch: TournamentBatch) {
  const chunks: BatchRowIdChunk[] = [];
  let manifest: TournamentBatch | StoredTournamentBatch = batch;
  if (batch.rowIds.length > BATCH_ROW_IDS_PER_CHUNK) {
    for (let i = 0; i < batch.rowIds.length; i += BATCH_ROW_IDS_PER_CHUNK)
      chunks.push({
        index: chunks.length,
        rowIds: batch.rowIds.slice(i, i + BATCH_ROW_IDS_PER_CHUNK),
      });
    const { rowIds, ...payload } = batch;
    manifest = {
      ...payload,
      rowIdStorage: {
        version: 1,
        count: rowIds.length,
        chunks: chunks.length,
        hash: hashEntry(rowIds, CHAIN_GENESIS),
      },
    };
  }
  // Preflight before any prediction create. Leave ample space for Firestore's
  // document names, field encoding and transaction overhead (1/10 MiB limits).
  const writes = [manifest, ...chunks, { date: batch.date, hash: batch.hash }];
  const sizes = writes.map((value) => Buffer.byteLength(canonicalJson(value)));
  if (
    writes.length > 400 ||
    sizes.some((size) => size > 512 * 1024) ||
    sizes.reduce((total, size) => total + size + 4096, 0) > 8 * 1024 * 1024
  )
    throw new Error("Batch publication exceeds safe atomic Firestore limits");
  return { manifest, chunks };
}

export async function firestoreTournamentLedger(
  namespace: Namespace,
): Promise<TournamentLedger> {
  const { db } = await import("../firebase-admin");
  const root = db.collection(namespace).doc("ledger");
  const createIdentical = async (
    collection: string,
    id: string,
    value: object,
  ) => {
    const ref = root.collection(collection).doc(id);
    try {
      await ref.create(value);
    } catch (error) {
      if ((error as { code?: number }).code !== 6) throw error;
      const existing = await ref.get();
      if (canonicalJson(existing.data()) !== canonicalJson(value))
        throw new Error(`append-only conflict: ${collection}/${id}`);
    }
  };
  const ledger: TournamentLedger = {
    async listBatches() {
      const s = await root.collection("batches").orderBy("date").get();
      return Promise.all(
        s.docs.map(async (d) => {
          const stored = d.data();
          if (!("rowIdStorage" in stored)) return stored as TournamentBatch;
          const { rowIdStorage, ...payload } = stored as StoredTournamentBatch;
          if (
            !rowIdStorage ||
            rowIdStorage.version !== 1 ||
            "rowIds" in payload ||
            !Number.isSafeInteger(rowIdStorage.count) ||
            rowIdStorage.count <= 0 ||
            !Number.isSafeInteger(rowIdStorage.chunks) ||
            rowIdStorage.chunks <= 0 ||
            rowIdStorage.chunks > 398 ||
            rowIdStorage.chunks !==
              Math.ceil(rowIdStorage.count / BATCH_ROW_IDS_PER_CHUNK)
          )
            throw new Error(`Invalid batch row-ID manifest on ${payload.date}`);
          const rowIds: string[] = [];
          for (let index = 0; index < rowIdStorage.chunks; index++) {
            const part = await d.ref.collection("rowIds").doc(String(index)).get();
            const chunk = part.data() as BatchRowIdChunk | undefined;
            if (
              !chunk ||
              chunk.index !== index ||
              !Array.isArray(chunk.rowIds) ||
              chunk.rowIds.length !==
                Math.min(BATCH_ROW_IDS_PER_CHUNK, rowIdStorage.count - rowIds.length) ||
              chunk.rowIds.some((id) => typeof id !== "string")
            )
              throw new Error(`Missing or invalid batch row-ID chunk on ${payload.date}`);
            rowIds.push(...chunk.rowIds);
          }
          if (
            rowIds.length !== rowIdStorage.count ||
            hashEntry(rowIds, CHAIN_GENESIS) !== rowIdStorage.hash
          )
            throw new Error(`Batch row-ID integrity mismatch on ${payload.date}`);
          return { ...payload, rowIds };
        }),
      );
    },
    async rows(date) {
      const s = await root
        .collection("predictions")
        .where("date", "==", date)
        .get();
      return s.docs.map((d) => d.data() as TournamentRow);
    },
    async appendBatch(batch, rows) {
      const batches = await ledger.listBatches(),
        existing = batches.find((b) => b.date === batch.date);
      if (existing) {
        if (
          canonicalJson(existing) !== canonicalJson(batch) ||
          canonicalJson(sorted(await ledger.rows(batch.date))) !==
            canonicalJson(sorted(rows))
        )
          throw new Error("append-only conflict");
        return "duplicate";
      }
      validateBatch(batch, rows, batches.at(-1) ?? null);
      const publication = batchPublication(batch);
      const assertTimely = () => {
        if (
          namespace === "tournament" &&
          rows.some(
            (r) =>
              Date.now() >= Date.parse(r.prediction.evaluationWindow!.entryAt),
          )
        )
          throw new Error("Live batch cannot be sealed after entry open");
      };
      assertTimely();
      // Unique per-day writers are serialized by the runtime lease. Retrying an
      // interrupted publication verifies each prior create before finishing.
      for (let i = 0; i < rows.length; i += 100)
        await Promise.all(
          rows
            .slice(i, i + 100)
            .map((r) => createIdentical("predictions", r.id, r)),
        );
      await db.runTransaction(async (tx) => {
        assertTimely();
        const head = root.collection("state").doc("head"),
          snap = await tx.get(head);
        if ((snap.data()?.hash ?? CHAIN_GENESIS) !== batch.previousHash)
          throw new Error("Concurrent batch changed chain head");
        const batchRef = root.collection("batches").doc(batch.date);
        for (const chunk of publication.chunks)
          tx.create(batchRef.collection("rowIds").doc(String(chunk.index)), chunk);
        tx.create(batchRef, publication.manifest);
        tx.set(head, { date: batch.date, hash: batch.hash });
      });
      return "created";
    },
    async grades() {
      const s = await root.collection("grades").get();
      return s.docs.map((d) => d.data() as TournamentGrade);
    },
    async appendGrade(g) {
      await createIdentical("grades", g.id, g);
    },
    async portfolios() {
      const s = await root.collection("portfolios").get();
      return s.docs.map((d) => d.data() as PaperSnapshot);
    },
    async appendPortfolio(p) {
      await createIdentical("portfolios", p.id, p);
    },
  };
  return ledger;
}

/** Create-only checkpoint chunks support an entire 500-name facts snapshot
 * without exceeding Firestore's 1 MiB document ceiling. */
export async function firestoreTournamentJournal(
  namespace: Namespace,
): Promise<Journal> {
  const { db } = await import("../firebase-admin");
  const root = db.collection(namespace).doc("ledger").collection("journal");
  const journal: Journal = {
    async get<T>(key: string) {
      const id = hashEntry(key, CHAIN_GENESIS),
        meta = await root.doc(id).get();
      if (!meta.exists) return null;
      const { chunks, hash } = meta.data()!;
      let json = "";
      for (let i = 0; i < chunks; i++) {
        const part = await root.doc(`${id}_${i}`).get();
        if (!part.exists) throw new Error("Incomplete checkpoint");
        json += part.data()!.text;
      }
      const value = JSON.parse(json);
      if (hashEntry(value, CHAIN_GENESIS) !== hash)
        throw new Error("Checkpoint integrity mismatch");
      return value as T;
    },
    async create(key, value) {
      const id = hashEntry(key, CHAIN_GENESIS),
        json = canonicalJson(value),
        chunks = Math.ceil(json.length / 150000);
      if (Buffer.byteLength(json) > 8 * 1024 * 1024 || chunks > 400)
        throw new Error("Checkpoint exceeds the atomic 8 MiB limit");
      // A single atomic commit prevents orphan chunks from poisoning a later
      // retry with a different startedAt timestamp after a process crash.
      const batch = db.batch();
      for (let i = 0; i < chunks; i++)
        batch.create(root.doc(`${id}_${i}`), {
          text: json.slice(i * 150000, (i + 1) * 150000),
        });
      batch.create(root.doc(id), {
        chunks,
        hash: hashEntry(value, CHAIN_GENESIS),
      });
      try {
        await batch.commit();
      } catch (error) {
        if ((error as { code?: number }).code !== 6) throw error;
        if (canonicalJson(await journal.get(key)) !== json)
          throw new Error("Checkpoint conflict");
      }
    },
  };
  return journal;
}

/** One writer across dates AND grading. Expiry exceeds the workflow timeout.
 * Crashed jobs can resume after expiry, reusing all completed checkpoints. */
export async function withTournamentLock<T>(
  namespace: Namespace,
  work: () => Promise<T>,
): Promise<T> {
  const { db } = await import("../firebase-admin");
  const ref = db
    .collection(namespace)
    .doc("ledger")
    .collection("state")
    .doc("writer");
  const owner = randomUUID();
  await db.runTransaction(async (tx) => {
    const old = await tx.get(ref);
    if (Number(old.data()?.expiresAt ?? 0) > Date.now())
      throw new Error("Tournament writer already active");
    tx.set(ref, { owner, expiresAt: Date.now() + 4 * 3600000 });
  });
  try {
    return await work();
  } finally {
    await db.runTransaction(async (tx) => {
      const old = await tx.get(ref);
      if (old.data()?.owner === owner) tx.set(ref, { owner, expiresAt: 0 });
    });
  }
}

/** Offline integration ledger; create-only files preserve the same contracts.
 * Kept in this module to maintain a single ledger-write boundary. */
export async function fileTournamentState(directory: string) {
  const fs = await import("node:fs/promises"),
    path = await import("node:path");
  await fs.mkdir(directory, { recursive: true });
  const file = (key: string) =>
    path.join(directory, `${hashEntry(key, CHAIN_GENESIS)}.json`);
  const journal: Journal = {
    async get<T>(key: string) {
      try {
        return JSON.parse(await fs.readFile(file(key), "utf8")) as T;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async create(key, value) {
      try {
        await fs.writeFile(file(key), canonicalJson(value), { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (canonicalJson(await journal.get(key)) !== canonicalJson(value))
          throw new Error("Checkpoint conflict");
      }
    },
  };
  // An index is reconstructed from immutable typed records; no mutable manifest.
  const list = async <T>(type: string): Promise<T[]> => {
    const result: T[] = [];
    for (const name of await fs.readdir(directory)) {
      if (!name.endsWith(".json")) continue;
      const item = JSON.parse(
        await fs.readFile(path.join(directory, name), "utf8"),
      );
      if (item?.type === type) result.push(item.value);
    }
    return result;
  };
  const memory = new MemoryTournamentLedger();
  for (const item of (
    await list<{ batch: TournamentBatch; rows: TournamentRow[] }>("batch")
  ).sort((a, b) => a.batch.date.localeCompare(b.batch.date)))
    await memory.appendBatch(item.batch, item.rows);
  for (const g of await list<TournamentGrade>("grade"))
    await memory.appendGrade(g);
  for (const p of await list<PaperSnapshot>("portfolio"))
    await memory.appendPortfolio(p);
  const ledger: TournamentLedger = {
    listBatches: () => memory.listBatches(),
    rows: (d) => memory.rows(d),
    grades: () => memory.grades(),
    portfolios: () => memory.portfolios(),
    async appendBatch(batch, rows) {
      const status = await memory.appendBatch(batch, rows);
      await journal.create(`batch_${batch.date}`, {
        type: "batch",
        value: { batch, rows },
      });
      return status;
    },
    async appendGrade(g) {
      await journal.create(`grade_${g.id}`, { type: "grade", value: g });
      await memory.appendGrade(g);
    },
    async appendPortfolio(p) {
      await journal.create(`portfolio_${p.id}`, {
        type: "portfolio",
        value: p,
      });
      await memory.appendPortfolio(p);
    },
  };
  return { ledger, journal };
}
