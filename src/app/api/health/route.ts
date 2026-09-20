import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { getHealthSnapshot } from "@/lib/providerHealth";
import { rateLimitGuard } from "@/lib/rateLimit";

export const runtime = "nodejs";
// A health check must never be cached — it has to reflect live state each hit.
export const dynamic = "force-dynamic";

/**
 * Liveness + readiness probe. Public (no auth) and deliberately thin: a tiny
 * Firestore read proves credentials + connectivity without exposing any data.
 * Returns 200 when healthy, 503 when a critical dependency is down — wire it into
 * uptime monitoring so a broken deploy is caught before users report it.
 *
 * Also carries provider health (`llm`, `data`) for the in-app degraded banner.
 * An AI/data vendor having trouble does NOT flip the HTTP status: that stays a
 * signal about our own stack, so a vendor outage can't page uptime monitoring.
 */
export async function GET(req: Request) {
  // Public, and every hit costs a shared-store read (plus a Firestore read on the
  // full probe). Generous for the banner's 60 s poll and uptime monitors; a flood
  // gets 429s instead of running up reads.
  const limited = await rateLimitGuard(req, "health", { capacity: 30, refillPerSec: 1 });
  if (limited) return limited;

  const providers = await getHealthSnapshot();

  // The in-app banner polls every 60s per open tab; it only needs provider state,
  // so it must not cost a Firestore read each time.
  if (new URL(req.url).searchParams.get("scope") === "providers") {
    return NextResponse.json({ ...providers, t: new Date().toISOString() });
  }

  const checks: Record<string, "ok" | "error"> = {};

  try {
    // Reading a non-existent doc still round-trips to Firestore (auth + network).
    await db.collection("_health").doc("_ping").get();
    checks.firestore = "ok";
  } catch {
    checks.firestore = "error";
  }

  const healthy = Object.values(checks).every((c) => c === "ok");
  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      checks,
      llm: providers.llm,
      data: { ...providers.data, firestore: checks.firestore },
      t: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 }
  );
}
