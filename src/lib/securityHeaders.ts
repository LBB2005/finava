/**
 * Site-wide HTTP security headers, consumed by `next.config.ts`'s `headers()`.
 *
 * Lives here rather than inline in next.config.ts so the policy is unit-testable
 * (vitest only picks up `src/**`) and so the third-party origin list sits next to
 * the code that actually loads those origins.
 *
 * The CSP ships REPORT-ONLY on purpose. A nonce-based enforcing policy would
 * force every page into dynamic rendering (Next applies nonces during SSR, so
 * static generation and PPR are off the table), and a static enforcing policy
 * risks silently breaking Google sign-in, Plaid Link, or the Stripe redirect —
 * flows that can't be exercised from a unit test. Report-only surfaces real
 * violations in the browser console first; once the reports are clean, flip the
 * key to `Content-Security-Policy` (see CSP_HEADER_KEY below).
 *
 * Everything else here is enforcing from the start — those headers have no way
 * to break a working page.
 */

/** Flip to "Content-Security-Policy" to enforce once report-only is clean. */
const CSP_HEADER_KEY = "Content-Security-Policy-Report-Only";

/** Where browsers POST violation reports (see /api/csp-report). */
const CSP_REPORT_PATH = "/api/csp-report";

/**
 * The directives that are safe to ENFORCE today, shipped as a second, enforcing
 * header next to the report-only one. None of them governs scripts, frames or
 * fetches, so none can break Google sign-in, Plaid Link or the Stripe redirect —
 * and together they block plugin embeds, `<base>` hijacking, form posts to
 * attacker origins, and framing.
 */
export function enforcedContentSecurityPolicy(): string {
  return [`object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`].join("; ");
}

/** Google identity: the sign-in popup's script, its frame, and the token APIs. */
const GOOGLE_SCRIPT = "https://apis.google.com";
const GOOGLE_FRAME = "https://accounts.google.com";
const FIREBASE_AUTH_API = "https://identitytoolkit.googleapis.com";
const FIREBASE_TOKEN_API = "https://securetoken.googleapis.com";

/** Plaid Link injects link-initialize.js and renders its flow in an iframe. */
const PLAID = "https://cdn.plaid.com";

/**
 * The policy body, as one flat line.
 *
 * `'unsafe-inline'` on script-src is a deliberate, documented compromise: Next's
 * hydration bootstrap and the inline appearance script in `app/layout.tsx` (which
 * must run before first paint to avoid a theme flash) are both inline. Dropping
 * it requires the nonce + dynamic-rendering trade above. Even with it, this
 * policy still buys the wins that matter here — no framing, no `<base>` hijack,
 * no form posts to attacker origins, no plugins, and an allowlist on which
 * external origins may be scripted or contacted at all.
 */
export function contentSecurityPolicy(): string {
  // React's development build evaluates code to reconstruct server stacks in the
  // browser; production needs no eval.
  const dev = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  // Firebase Auth's helper iframe (<authDomain>/__/auth/iframe) is loaded on every
  // popup/redirect sign-in and on page load in Safari — omitting it here is what
  // would break sign-in the day this policy is enforced.
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
  const firebaseAuthFrame = authDomain ? ` https://${authDomain}` : "";

  return [
    `default-src 'self'`,
    `script-src 'self' 'unsafe-inline'${dev} ${GOOGLE_SCRIPT} ${PLAID}`,
    // Tailwind and next/font emit inline style blocks.
    `style-src 'self' 'unsafe-inline'`,
    // next/font/google self-hosts its files at build time, so no external font host.
    `font-src 'self' data:`,
    // The stock News tab renders OpenGraph thumbnails resolved from arbitrary
    // publisher domains, so image origins can't be enumerated.
    `img-src 'self' https: data: blob:`,
    `connect-src 'self' ${FIREBASE_AUTH_API} ${FIREBASE_TOKEN_API} ${GOOGLE_SCRIPT} ${PLAID}`,
    `frame-src 'self'${firebaseAuthFrame} ${GOOGLE_FRAME} ${PLAID}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
    // Report-only with nowhere to report is invisible; these make violations
    // show up in the server logs, so the policy can be enforced with evidence.
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to csp`,
  ].join("; ");
}

export interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/** Header rules for `next.config.ts`. */
export function securityHeaderRules(): HeaderRule[] {
  return [
    {
      source: "/(.*)",
      headers: [
        // 2 years. No `preload` — a preload-list entry is painful to unwind, so
        // that's an explicit decision to make, not a default to inherit.
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains",
        },
        // Clickjacking. /settings alone carries Delete account and Export data;
        // frame-ancestors above covers modern browsers, this covers the rest.
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        // Send only the origin cross-site: full URLs would leak /share/{id}
        // links and the tickers a user viewed to every outbound destination.
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        // Nothing in the app uses these; payments happen on Stripe's own domain.
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        },
        // Isolates the browsing context WITHOUT severing window.opener, which
        // `same-origin` would do — that breaks signInWithPopup.
        { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        { key: CSP_HEADER_KEY, value: contentSecurityPolicy() },
        { key: "Content-Security-Policy", value: enforcedContentSecurityPolicy() },
        { key: "Reporting-Endpoints", value: `csp="${CSP_REPORT_PATH}"` },
      ],
    },
  ];
}
