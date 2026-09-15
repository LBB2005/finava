/**
 * OpenRouter low-balance alert.
 *
 * Every routed LLM call goes through one OpenRouter account. On 13 Sep 2026 its
 * balance hit zero and nobody knew until testers did: Auto quietly became plain
 * chat and Discover returned the same names for every query. This job reads the
 * balance and emails the admins while there is still time to top up.
 *
 * Remaining = the tighter of the account balance (/credits: total_credits −
 * total_usage) and the key's own spend limit (/key: limit_remaining, null when
 * the key is unlimited). If neither can be read, that is alerted too — a revoked
 * key fails exactly like an empty balance.
 *
 * Env:
 *   OPENROUTER_ALERT_USD — alert threshold in USD (default 10)
 *   OPS_ALERT_EMAIL      — comma-separated recipients; falls back to ADMIN_EMAILS
 *
 * Scheduled via vercel.json `crons`; authorized by CRON_SECRET (Vercel Cron sends
 * it as `Authorization: Bearer <CRON_SECRET>`).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { sendEmail } from "@/lib/email/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const OPENROUTER_API = "https://openrouter.ai/api/v1";
const DEFAULT_THRESHOLD_USD = 10;

// Same check as reconcile-subscriptions: fail closed, constant-time compare.
function cronAuthorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function thresholdUsd(): number {
  const n = Number(process.env.OPENROUTER_ALERT_USD);
  return process.env.OPENROUTER_ALERT_USD && Number.isFinite(n) && n >= 0 ? n : DEFAULT_THRESHOLD_USD;
}

async function readJson(path: string, apiKey: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${OPENROUTER_API}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[cron/openrouter-balance] ${path} returned ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { data?: Record<string, unknown> };
    return body.data ?? null;
  } catch (err) {
    console.error(`[cron/openrouter-balance] ${path} failed:`, err);
    return null;
  }
}

/** Remaining USD, or null when it can't be established. */
async function remainingUsd(apiKey: string): Promise<number | null> {
  const [credits, key] = await Promise.all([readJson("/credits", apiKey), readJson("/key", apiKey)]);
  const candidates: number[] = [];
  if (credits && typeof credits.total_credits === "number" && typeof credits.total_usage === "number") {
    candidates.push(credits.total_credits - credits.total_usage);
  }
  if (key && typeof key.limit_remaining === "number") candidates.push(key.limit_remaining);
  // An unlimited key (limit_remaining null) says nothing about the account balance.
  if (!candidates.length) return null;
  return Math.round(Math.min(...candidates) * 100) / 100;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const threshold = thresholdUsd();
  const apiKey = process.env.OPENROUTER_API_KEY;
  const remaining = apiKey ? await remainingUsd(apiKey) : null;

  const unreadable = remaining === null;
  const low = !unreadable && remaining < threshold;
  const status = unreadable ? 502 : 200;

  if (!unreadable && !low) {
    return NextResponse.json({ remainingUsd: remaining, thresholdUsd: threshold, alerted: false });
  }

  const recipients = envList("OPS_ALERT_EMAIL").length ? envList("OPS_ALERT_EMAIL") : envList("ADMIN_EMAILS");
  if (!recipients.length) {
    console.error("[cron/openrouter-balance] alert needed but no OPS_ALERT_EMAIL / ADMIN_EMAILS set");
    return NextResponse.json(
      { remainingUsd: remaining, thresholdUsd: threshold, alerted: false, reason: "no recipients" },
      { status }
    );
  }

  const subject = unreadable
    ? "Finava: could not read the OpenRouter balance"
    : `Finava: OpenRouter balance is ${usd(remaining)}`;
  const text = unreadable
    ? `The daily check could not read the OpenRouter balance${apiKey ? " (the key may be revoked or the API down)" : " (OPENROUTER_API_KEY is not set)"}.\n\nIf OpenRouter is unavailable, routed agents fall back to direct providers where keys exist; everything else fails. Check https://openrouter.ai/settings/credits.`
    : `The OpenRouter balance is ${usd(remaining)}, below the alert threshold of ${usd(threshold)}.\n\nWhen it reaches zero, every routed agent fails over to direct providers or stops. Top up at https://openrouter.ai/settings/credits.`;
  const html = `<p>${text.replace(/\n\n/g, "</p><p>")}</p>`;

  const result = await sendEmail(recipients, { subject, text, html });
  return NextResponse.json(
    { remainingUsd: remaining, thresholdUsd: threshold, alerted: result.sent },
    { status }
  );
}
