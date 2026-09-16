import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { assignTesterPlan, isPlanName, readTesterPlan } from "@/lib/testerPlan";

/**
 * GET  /api/admin/tester-plan?email=…|uid=…  → the plan a tester is currently on.
 * POST /api/admin/tester-plan                → put them on one, or clear it.
 *
 * Body (POST): { "email": "tester@example.com", "plan": "Analyst" }
 *              { "uid": "abc123", "plan": null }   ← back to full admin access
 *
 * Why it exists: allowlisted testers resolve to uncapped Quant, so nobody in the
 * beta ever saw a credit limit, a per-run cap, or an upgrade prompt — and then
 * 0 of 50 of them said they would pay for it. This puts a tester inside a real
 * plan. It never touches Stripe state (see `testerPlan.ts`).
 */
export const runtime = "nodejs";

export async function GET(request: Request) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const url = new URL(request.url);
  const result = await readTesterPlan({
    uid: url.searchParams.get("uid") ?? undefined,
    email: url.searchParams.get("email") ?? undefined,
  });
  return result.ok
    ? NextResponse.json({ uid: result.uid, plan: result.plan })
    : NextResponse.json({ error: result.error }, { status: result.status });
}

export async function POST(request: Request) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  let body: { uid?: string; email?: string; plan?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  // `plan: null` is the clear operation, so absent and null are different things.
  if (body.plan !== null && !isPlanName(body.plan)) {
    return NextResponse.json(
      { error: 'plan must be "Free", "Analyst", "Pro", "Quant", or null to clear.' },
      { status: 400 }
    );
  }

  const result = await assignTesterPlan(
    { uid: body.uid, email: body.email },
    body.plan as Parameters<typeof assignTesterPlan>[1]
  );
  return result.ok
    ? NextResponse.json({ uid: result.uid, plan: result.plan })
    : NextResponse.json({ error: result.error }, { status: result.status });
}
