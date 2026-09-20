import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/requireAuth";
import { isOwnerUid } from "@/lib/adminAllowlist";

/**
 * Gate a route to operators only: a valid auth token AND a UID in OWNER_UIDS.
 *
 * NOT the tester allowlist (ADMIN_UIDS / ADMIN_EMAILS). Being allowed to use the
 * beta must never imply being allowed to run the admin tools. See ownerUids().
 */
export async function requireAdmin(): Promise<
  { userId: string; error?: never } | { userId?: never; error: NextResponse }
> {
  const auth = await requireAuth();
  if (auth.error) return { error: auth.error };

  const isDevUser = auth.userId === "dev-user" && process.env.NODE_ENV !== "production";
  if (!isDevUser && !isOwnerUid(auth.userId)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { userId: auth.userId };
}
