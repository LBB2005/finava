import { vi } from "vitest";

/** In-memory stand-in for the Firebase Admin Firestore surface the app uses:
 *  db.collection(...).doc(...).get()/set()/update(), and simple collection queries.
 *  Seed with plain objects keyed by `${collection}/${id}`. */
export function makeFirestoreMock(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));

  const docRef = (path: string) => ({
    id: path.split("/").pop()!,
    get: vi.fn(async () => ({
      exists: store.has(path),
      id: path.split("/").pop()!,
      data: () => store.get(path),
    })),
    set: vi.fn(async (v: unknown, opts?: { merge?: boolean }) => {
      store.set(
        path,
        opts?.merge ? { ...(store.get(path) as object), ...(v as object) } : v,
      );
    }),
    update: vi.fn(async (v: unknown) => {
      store.set(path, { ...(store.get(path) as object), ...(v as object) });
    }),
  });

  const collectionRef = (col: string) => ({
    doc: (id: string) => docRef(`${col}/${id}`),
    where: vi.fn(() => collectionRef(col)),
    get: vi.fn(async () => ({
      docs: [...store.entries()]
        .filter(([k]) => k.startsWith(`${col}/`))
        .map(([k, v]) => ({ id: k.split("/").pop()!, data: () => v })),
    })),
  });

  // Transactions run one at a time: real Firestore transactions are
  // serializable (optimistic concurrency with retries), so a serialized mock is
  // a faithful model for testing read-then-write logic under concurrency.
  let txChain: Promise<unknown> = Promise.resolve();
  const runTransaction = <T,>(fn: (tx: {
    get: (ref: ReturnType<typeof docRef>) => ReturnType<ReturnType<typeof docRef>["get"]>;
    set: (ref: ReturnType<typeof docRef>, v: unknown, opts?: { merge?: boolean }) => void;
  }) => Promise<T>): Promise<T> => {
    const run = txChain.then(async () => {
      const writes: Array<() => Promise<void>> = [];
      const result = await fn({
        get: (ref) => ref.get(),
        set: (ref, v, opts) => void writes.push(() => ref.set(v, opts)),
      });
      for (const w of writes) await w();
      return result;
    });
    txChain = run.catch(() => {});
    return run;
  };

  return { db: { collection: (c: string) => collectionRef(c), runTransaction }, store };
}
