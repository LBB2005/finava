/**
 * Shape check for a client-supplied Firestore document id (a conversation,
 * template, watchlist, holding, …) before it becomes a path segment or a URL.
 *
 * `.doc(id)` treats "/" as a path separator, so an id like "<uid>/holdings/x"
 * addressed a different collection (inside the caller's own tree — but the
 * briefing cron's collectionGroup walk then read the planted parent as a user
 * id), and on the client `/api/conversations/${id}` with id "../user" called a
 * different API route. Ids this app mints are UUIDs, Firestore auto-ids, or
 * tickers (holdings, e.g. "BRK.B"), so this allows exactly that alphabet.
 */
export const DOC_ID_RE = /^(?!\.\.?$)[A-Za-z0-9._:-]{1,150}$/;

export function isSafeDocId(id: unknown): id is string {
  return typeof id === "string" && DOC_ID_RE.test(id);
}
