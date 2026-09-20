"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut as firebaseSignOut,
  User,
} from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  devEnabled: boolean;
  devBypass: boolean;
  toggleDevBypass: () => void;
  /** True after a real, non-admin user was bounced by the private-beta gate. */
  betaDenied: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  signIn: async () => {},
  signOut: async () => {},
  devEnabled: false,
  devBypass: false,
  toggleDevBypass: () => {},
  betaDenied: false,
});

// Routes a logged-out visitor is allowed to see (no redirect to /login).
const PUBLIC_ROUTES = ["/", "/login", "/privacy", "/terms"];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.includes(pathname);
}

// Dev-only auth bypass: never available in a production build.
const DEV_ENABLED = process.env.NODE_ENV !== "production";

// Private-beta lockdown. The allowlist lives ONLY on the server (requireAuth):
// the client asks /api/auth/access once per page load and treats a 403
// "Private beta" as locked out. It used to mirror the allowlist from
// NEXT_PUBLIC_ADMIN_UIDS / NEXT_PUBLIC_ADMIN_EMAILS, which shipped every tester's
// email address to every visitor in the public JS bundle. UX only — every API
// route re-checks, so a network failure here fails open, never closed.
async function isBetaBlocked(u: User): Promise<boolean> {
  try {
    const token = await u.getIdToken();
    const res = await fetch("/api/auth/access", { headers: { Authorization: `Bearer ${token}` } });
    if (res.status !== 403) return false;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error === "Private beta";
  } catch {
    return false;
  }
}

// Stand-in for a Firebase user. Has no real UID/token, so authenticated
// Firestore reads and token-gated API calls will not work under it.
const MOCK_USER = {
  uid: "dev-user",
  email: "dev@finava.local",
  displayName: "Dev User",
  photoURL: null,
  emailVerified: true,
  isAnonymous: false,
} as unknown as User;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [realUser, setRealUser] = useState<User | null>(null);
  const [devBypass, setDevBypass] = useState(false);
  const [betaDenied, setBetaDenied] = useState(false);
  // A real, non-allowlisted user under the beta lockdown is treated as
  // not-signed-in: the server rejects their token anyway, so never mount the
  // app shell for them.
  const [betaLockedOut, setBetaLockedOut] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const user = betaLockedOut
    ? null
    : realUser ?? (DEV_ENABLED && devBypass ? MOCK_USER : null);

  // localStorage is client-only; reading it in an effect (not render) is the
  // hydration-safe way to pick up the dev-auth bypass flag without an SSR mismatch.
  useEffect(() => {
    if (DEV_ENABLED && typeof window !== "undefined") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDevBypass(localStorage.getItem("finava_dev_auth") === "1");
    }
  }, []);

  useEffect(() => {
    // Handle redirect result on page load (after Google redirect back)
    getRedirectResult(auth).catch(() => {});

    // Auth state can change again while an access check is in flight (sign in,
    // then out); only the newest change may commit its result.
    let seq = 0;
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      const mine = ++seq;
      const blocked = firebaseUser ? await isBetaBlocked(firebaseUser) : false;
      if (mine !== seq) return;
      setBetaLockedOut(blocked);
      setRealUser(firebaseUser);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (loading) return;
    // Private-beta gate: a non-admin signed in with a valid Google account. Sign
    // them straight back out and show the "private beta" notice on /login.
    if (betaLockedOut) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBetaDenied(true);
      firebaseSignOut(auth).catch(() => {});
      if (pathname !== "/login") router.push("/login");
      return;
    }
    if (!user && !isPublicRoute(pathname)) {
      router.push("/login");
    }
    if (user && (pathname === "/login" || pathname === "/")) {
      router.push("/chat");
    }
  }, [user, loading, pathname, router, betaLockedOut]);

  function toggleDevBypass() {
    if (!DEV_ENABLED) return;
    setDevBypass((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        if (next) localStorage.setItem("finava_dev_auth", "1");
        else localStorage.removeItem("finava_dev_auth");
      }
      return next;
    });
  }

  async function signIn() {
    setBetaDenied(false);
    try {
      // Try popup first (works in most desktop browsers)
      await signInWithPopup(auth, googleProvider);
    } catch (err: unknown) {
      // Fall back to redirect if popup is blocked
      const code = (err as { code?: string })?.code;
      if (code === "auth/popup-blocked" || code === "auth/popup-closed-by-user") {
        await signInWithRedirect(auth, googleProvider);
      } else {
        throw err;
      }
    }
  }

  async function signOut() {
    if (DEV_ENABLED && devBypass) {
      setDevBypass(false);
      if (typeof window !== "undefined") localStorage.removeItem("finava_dev_auth");
    }
    await firebaseSignOut(auth);
    // A full navigation, not router.push: the SWR cache (portfolio, conversations)
    // and the chat store live in memory and aren't keyed by user, so a soft
    // navigation left the previous account's data on screen — and in the next
    // account's first prompt — on a shared browser.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a hard navigation is the point: it drops in-memory state
    window.location.assign("/login");
  }

  return (
    <AuthContext.Provider
      value={{ user, loading, signIn, signOut, devEnabled: DEV_ENABLED, devBypass, toggleDevBypass, betaDenied }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
