import { NextResponse } from "next/server";
import * as admin from "firebase-admin";
import { db } from "@/lib/firebase-admin";
import { requireAdmin } from "@/lib/requireAdmin";
import { sendEmail } from "@/lib/email/client";
import { weeklyUpdateEmail } from "@/lib/email/templates";
import { latestIssue, issueByIndex } from "@/lib/email/weekly-issues";

/**
 * GET  /api/admin/weekly[?issue=N]   → preview the rendered HTML in a browser.
 * POST /api/admin/weekly             → send the latest (or ?issue=N) update to
 *                                        the whole waitlist. Admin only.
 *
 * Body (POST, optional): { "issue": number, "test": "you@example.com" }
 *   - test: send only to that address (dry run before the real blast).
 */

const SEND_CONCURRENCY = 5;

export async function GET(request: Request) {
  // In dev, allow open preview so you can just open the URL. In production,
  // require an admin token.
  if (process.env.NODE_ENV === "production") {
    const gate = await requireAdmin();
    if (gate.error) return gate.error;
  }

  const url = new URL(request.url);
  const idxParam = url.searchParams.get("issue");
  const issue =
    idxParam != null ? issueByIndex(Number(idxParam)) : latestIssue();
  if (!issue) {
    return NextResponse.json({ error: "No such issue" }, { status: 404 });
  }

  const { html } = weeklyUpdateEmail(issue);
  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function POST(request: Request) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  let body: { issue?: number; test?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body is fine — defaults to latest issue, full send */
  }

  const issue =
    body.issue != null ? issueByIndex(body.issue) : latestIssue();
  if (!issue) {
    return NextResponse.json({ error: "No such issue" }, { status: 404 });
  }
  const content = weeklyUpdateEmail(issue);
  const issueKey = issue.issueLabel;

  // Dry run — send to ONE test address, no Firestore writes. sendEmail accepts an
  // array, so an unchecked `test` was a free-form bulk sender.
  if (body.test !== undefined) {
    if (typeof body.test !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.test)) {
      return NextResponse.json({ error: "test must be a single email address" }, { status: 400 });
    }
    const result = await sendEmail(body.test, content);
    return NextResponse.json({ test: body.test, result });
  }

  // Collect recipients from the waitlist, skipping anyone who already has this
  // issue — a double-click or a retried request must not mail the list twice.
  const snap = await db.collection("waitlist").get();
  const recipients = snap.docs
    .filter((d) => d.data().lastWeeklyIssue !== issueKey)
    .map((d) => (d.data().email as string) || d.id)
    .filter((e) => typeof e === "string" && e.includes("@"));

  if (recipients.length === 0) {
    return NextResponse.json({ sent: 0, failed: 0, total: 0 });
  }

  let sent = 0;
  let failed = 0;

  // Bounded concurrency so a large list doesn't open hundreds of sockets.
  for (let i = 0; i < recipients.length; i += SEND_CONCURRENCY) {
    const chunk = recipients.slice(i, i + SEND_CONCURRENCY);
    await Promise.all(
      chunk.map(async (email) => {
        const result = await sendEmail(email, content);
        if (result.sent) {
          sent++;
          await db
            .collection("waitlist")
            .doc(email)
            .set(
              {
                lastWeeklyIssue: issueKey,
                lastWeeklySentAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            )
            .catch(() => {});
        } else if (!result.skipped) {
          failed++;
        }
      })
    );
  }

  return NextResponse.json({
    issue: issueKey,
    total: recipients.length,
    sent,
    failed,
    note:
      sent === 0 && failed === 0
        ? "Email not configured (RESEND_API_KEY missing) — nothing sent."
        : undefined,
  });
}
