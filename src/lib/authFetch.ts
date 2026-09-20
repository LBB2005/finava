"use client";
import { auth } from "@/lib/firebase";

/** Sentinel sent in place of a real ID token when the dev-auth bypass is on.
 *  The server only honours it outside production (see requireAuth). */
export const DEV_BYPASS_TOKEN = "dev-bypass";

/** Get the current Firebase ID token, or null if not signed in.
 *  Under the "DEV AUTH ON" toggle there is no real Firebase user, so we send a
 *  dev sentinel (non-production only) that requireAuth maps to the dev user —
 *  this lets authed APIs work in local/preview dev without a Google sign-in. */
export async function getAuthToken(): Promise<string | null> {
  // On a fresh page load Firebase restores the session from IndexedDB
  // asynchronously; until it has, currentUser is null even for a signed-in user.
  // Wait for that first resolution so an early request doesn't go out tokenless
  // and 401 (every data route requires a session). Resolves instantly afterwards.
  await auth.authStateReady?.();
  const user = auth.currentUser;
  if (user) return user.getIdToken();
  if (
    process.env.NODE_ENV !== "production" &&
    typeof window !== "undefined" &&
    localStorage.getItem("finava_dev_auth") === "1"
  ) {
    return DEV_BYPASS_TOKEN;
  }
  return null;
}

/** Wrapper around fetch() that automatically adds the Firebase Bearer token. */
export async function authFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = await getAuthToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

/** SWR-compatible fetcher that includes the Firebase auth token. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const authFetcher = async <T = any>(url: string): Promise<T> => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as T;
};
