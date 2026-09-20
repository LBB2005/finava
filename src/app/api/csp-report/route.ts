import { NextResponse } from "next/server";
import { rateLimitGuard } from "@/lib/rateLimit";
import { logger } from "@/lib/logger";

const log = logger("csp");

/** Largest report body read; a real report is well under 2 KB. */
const MAX_BODY = 8_192;
/** Reports handled per request (the Reporting API batches). */
const MAX_REPORTS = 10;

function host(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return new URL(raw).host || raw.slice(0, 40);
  } catch {
    return raw.slice(0, 40); // "inline", "eval", "self" …
  }
}

function path(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    return new URL(raw).pathname;
  } catch {
    return null;
  }
}

/**
 * POST /api/csp-report — Content-Security-Policy violation reports.
 *
 * Accepts both the legacy `report-uri` shape ({"csp-report": {...}}) and the
 * Reporting API batch ([{type, body}]). Logs only the violated directive, the
 * blocked HOST and the page PATH — never full URLs, whose query strings could
 * carry tokens or tickers. Public by nature (browsers post without credentials),
 * so it's rate-limited per client and always answers 204.
 */
export async function POST(req: Request) {
  const limited = await rateLimitGuard(req, "csp-report", { capacity: 20, refillPerSec: 0.2 });
  if (limited) return new NextResponse(null, { status: 204 });

  const text = (await req.text().catch(() => "")).slice(0, MAX_BODY);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const reports = (Array.isArray(parsed) ? parsed : [parsed]).slice(0, MAX_REPORTS);
  for (const r of reports) {
    const rec = (r ?? {}) as Record<string, unknown>;
    const body = (rec["csp-report"] ?? rec.body ?? {}) as Record<string, unknown>;
    log.warn("csp violation", {
      directive: String(body["effective-directive"] ?? body.effectiveDirective ?? body["violated-directive"] ?? "").slice(0, 60),
      blocked: host(body["blocked-uri"] ?? body.blockedURL),
      page: path(body["document-uri"] ?? body.documentURL),
    });
  }
  return new NextResponse(null, { status: 204 });
}
