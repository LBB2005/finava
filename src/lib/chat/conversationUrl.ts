/** The /chat URL for a conversation. The id rides in `?c=` so the route stays one page. */
export function chatHref(convId: string | null): string {
  return convId ? `/chat?c=${encodeURIComponent(convId)}` : "/chat";
}

export type UrlAction = { kind: "none" } | { kind: "open"; id: string } | { kind: "clear" };
export type StoreAction = { kind: "none" } | { kind: "write"; href: string; replace: boolean };

/** The URL changed (reload, back/forward, a pasted link): the store follows it. */
export function onUrlConversationChange(urlId: string | null, storeId: string | null): UrlAction {
  if (urlId === storeId) return { kind: "none" };
  return urlId ? { kind: "open", id: urlId } : { kind: "clear" };
}

/** The viewed conversation changed in the app: the URL follows it. */
export function onStoreConversationChange(storeId: string | null, urlId: string | null): StoreAction {
  if (storeId === urlId) return { kind: "none" };
  // A fresh chat just got its id: rewrite the bare /chat entry in place.
  const replace = urlId === null;
  return { kind: "write", href: chatHref(storeId), replace };
}
