import { NextResponse, after } from "next/server";
import * as admin from "firebase-admin";
import { db } from "@/lib/firebase-admin";
import { sendEmail } from "@/lib/email/client";
import { waitlistConfirmationEmail } from "@/lib/email/templates";
import { rateLimitGuard } from "@/lib/rateLimit";
import { normalizeMailbox } from "@/lib/email/normalize";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Most confirmation emails sent per UTC day, across ALL signups. Per-IP limits
 * can't bound a distributed flood of fresh addresses, and every confirmation
 * spends finava.ai's sender reputation; past the cap, signups still save but
 * the confirmation is skipped (it's a courtesy, not a gate).
 */
const DAILY_CONFIRMATION_CAP = 300;

/** Count one confirmation against today's cap; false once the cap is spent. */
async function takeConfirmationSlot(): Promise<boolean> {
  const ref = db.collection("waitlistStats").doc(new Date().toISOString().slice(0, 10));
  return db.runTransaction(async (tx) => {
    const sent = ((await tx.get(ref)).data()?.confirmations as number | undefined) ?? 0;
    if (sent >= DAILY_CONFIRMATION_CAP) return false;
    tx.set(ref, { confirmations: sent + 1 }, { merge: true });
    return true;
  });
}

export async function POST(request: Request) {
  // Public, unauthenticated, and sends an email + writes Firestore on first
  // signup — throttle per client IP so it can't be scripted into a mail-bomb or
  // unbounded write spam against Resend/Firestore.
  const limited = await rateLimitGuard(request, "waitlist", { capacity: 5, refillPerSec: 0.05 });
  if (limited) return limited;

  let email: string;
  try {
    const body = await request.json();
    email = String(body?.email ?? "").trim().toLowerCase();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  try {
    // Keyed on the delivering MAILBOX, not the exact string, so sub-address and
    // dot variants of one inbox are one signup — at most one confirmation each.
    const ref = db.collection("waitlist").doc(normalizeMailbox(email));
    const existing = await ref.get();
    const isNew = !existing.exists;

    await ref.set(
      {
        email,
        source: "landing",
        ...(isNew ? { createdAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
      },
      { merge: true }
    );

    // Send the confirmation only on first signup — don't re-email duplicate
    // submits. Run it AFTER the response so the Resend round-trip neither blocks
    // the reply nor makes first-signup responses measurably slower than repeat
    // ones — that latency gap would otherwise leak whether an address is already
    // on the waitlist. sendEmail never throws, so post-response failures can't
    // affect the already-sent reply.
    if (isNew) {
      after(async () => {
        if (!(await takeConfirmationSlot().catch(() => false))) return;
        const result = await sendEmail(email, waitlistConfirmationEmail());
        await ref.set(
          {
            confirmationSent: result.sent,
            confirmationSentAt: result.sent
              ? admin.firestore.FieldValue.serverTimestamp()
              : null,
          },
          { merge: true }
        );
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[waitlist POST]", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
