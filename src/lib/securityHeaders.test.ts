import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { securityHeaderRules, contentSecurityPolicy } from "./securityHeaders";

/** The header map for the rule covering every path. */
function globalHeaders(): Record<string, string> {
  const rule = securityHeaderRules().find((r) => r.source === "/(.*)");
  if (!rule) throw new Error("no catch-all header rule");
  return Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
}

/** Directives of the report-only CSP, keyed by directive name. */
function directives(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of contentSecurityPolicy().split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values.join(" ");
  }
  return out;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("securityHeaderRules", () => {
  it("covers every path, so no route ships bare", () => {
    expect(securityHeaderRules().some((r) => r.source === "/(.*)")).toBe(true);
  });

  it("refuses to be framed, closing the clickjacking hole on /settings", () => {
    // Settings holds Delete account + Export my data — the highest-value
    // one-click actions in the app.
    expect(globalHeaders()["X-Frame-Options"]).toBe("DENY");
    expect(directives()["frame-ancestors"]).toBe("'none'");
  });

  it("blocks MIME sniffing and trims the cross-origin referrer", () => {
    expect(globalHeaders()["X-Content-Type-Options"]).toBe("nosniff");
    // Full URLs would leak /share/{id} tokens and viewed tickers to third parties.
    expect(globalHeaders()["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("sets HSTS without claiming preload", () => {
    const hsts = globalHeaders()["Strict-Transport-Security"];
    expect(hsts).toMatch(/max-age=\d{7,}/);
    expect(hsts).toContain("includeSubDomains");
    // Preload list entry is effectively irreversible — opt in deliberately, not by default.
    expect(hsts).not.toContain("preload");
  });

  it("keeps Google sign-in popups working under COOP", () => {
    // `same-origin` severs window.opener and breaks signInWithPopup.
    expect(globalHeaders()["Cross-Origin-Opener-Policy"]).toBe("same-origin-allow-popups");
  });

  it("ships the full CSP report-only so a wrong directive cannot break checkout or Plaid", () => {
    const headers = globalHeaders();
    expect(headers["Content-Security-Policy-Report-Only"]).toBeTruthy();
  });

  // Report-only enforces nothing, so the directives that can't break any flow are
  // ENFORCED in their own header — nothing that governs scripts, frames or fetches.
  it("enforces only the break-proof directives", () => {
    const enforced = globalHeaders()["Content-Security-Policy"];
    expect(enforced).toBe("object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    for (const risky of ["script-src", "connect-src", "frame-src", "img-src", "default-src"]) {
      expect(enforced).not.toContain(risky);
    }
  });

  it("reports violations somewhere a human can read them", () => {
    expect(directives()["report-uri"]).toBe("/api/csp-report");
    expect(directives()["report-to"]).toBe("csp");
    expect(globalHeaders()["Reporting-Endpoints"]).toBe('csp="/api/csp-report"');
  });

  it("allows the Firebase auth helper iframe, which sign-in needs", () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "lucra-ce8de.firebaseapp.com");
    expect(directives()["frame-src"]).toContain("https://lucra-ce8de.firebaseapp.com");
  });
});

describe("contentSecurityPolicy", () => {
  it("locks down the directives an injected page would abuse", () => {
    const d = directives();
    expect(d["default-src"]).toBe("'self'");
    expect(d["object-src"]).toBe("'none'");
    expect(d["base-uri"]).toBe("'self'");
    expect(d["form-action"]).toBe("'self'");
  });

  it("allows the origins Google sign-in and Plaid Link actually load", () => {
    const d = directives();
    expect(d["script-src"]).toContain("https://apis.google.com");
    expect(d["script-src"]).toContain("https://cdn.plaid.com");
    expect(d["frame-src"]).toContain("https://accounts.google.com");
    expect(d["frame-src"]).toContain("https://cdn.plaid.com");
    expect(d["connect-src"]).toContain("https://identitytoolkit.googleapis.com");
    expect(d["connect-src"]).toContain("https://securetoken.googleapis.com");
  });

  it("allows article thumbnails from any publisher over https", () => {
    // The stock News tab renders OpenGraph images resolved from arbitrary domains.
    expect(directives()["img-src"]).toContain("https:");
  });

  it("permits eval in development only", () => {
    expect(contentSecurityPolicy()).not.toContain("'unsafe-eval'");

    vi.stubEnv("NODE_ENV", "development");
    // React's dev build uses eval to rebuild server stacks in the browser.
    expect(contentSecurityPolicy()).toContain("'unsafe-eval'");
  });

  it("emits a single flat line", () => {
    // A header value carrying raw newlines is silently dropped or truncated.
    const csp = contentSecurityPolicy();
    expect(csp).not.toMatch(/[\n\r]/);
    expect(csp).not.toMatch(/\s{2,}/);
  });
});
