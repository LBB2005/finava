import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/requireAuth";

/**
 * GET /api/auth/access — may this signed-in account use the app?
 *
 * The private-beta allowlist lives only on the server (requireAuth). The client
 * used to mirror it from NEXT_PUBLIC_ADMIN_UIDS / NEXT_PUBLIC_ADMIN_EMAILS, which
 * baked every tester's email address into the public JS bundle. Now it asks here:
 *   200 → allowed · 403 "Private beta" → signed in but not allowlisted · 401 → no session.
 */
export async function GET() {
  const { error } = await requireAuth();
  if (error) return error;
  return NextResponse.json({ ok: true });
}
