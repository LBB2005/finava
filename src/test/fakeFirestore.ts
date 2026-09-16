// src/test/fakeFirestore.ts
// Minimal path-based Firestore fake for tests: collection/doc chains, get/set
// (with merge), collection get() over direct children, orderBy (no-op sort by id).
type Data = Record<string, unknown>;

export function createFakeFirestore() {
  const docs = new Map<string, Data>();

  function docRef(path: string) {
    return {
      id: path.split("/").at(-1)!,
      path,
      async get() {
        const d = docs.get(path);
        return { id: path.split("/").at(-1)!, exists: d !== undefined, data: () => (d ? structuredClone(d) : undefined) };
      },
      async set(data: Data, opts?: { merge?: boolean }) {
        const prev = opts?.merge ? docs.get(path) ?? {} : {};
        docs.set(path, structuredClone({ ...prev, ...data }));
      },
      collection: (name: string) => collectionRef(`${path}/${name}`),
    };
  }

  function collectionRef(path: string) {
    const depth = path.split("/").length + 1;
    const ref = {
      doc: (id: string) => docRef(`${path}/${id}`),
      orderBy: () => ref,
      async get() {
        const matches = [...docs.keys()]
          .filter((k) => k.startsWith(`${path}/`) && k.split("/").length === depth)
          .sort()
          .map((k) => ({ id: k.split("/").at(-1)!, ref: docRef(k), data: () => structuredClone(docs.get(k)!) }));
        return { docs: matches, empty: matches.length === 0 };
      },
    };
    return ref;
  }

  return { db: { collection: (name: string) => collectionRef(name) }, docs };
}
