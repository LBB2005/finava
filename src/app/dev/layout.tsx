import { notFound } from "next/navigation";
import type { ReactNode } from "react";

// Rendered per request so a deployed build answers a real 404, not a prerendered
// not-found page served with 200.
export const dynamic = "force-dynamic";

/**
 * /dev/* holds developer fixtures (the answer-card preview). Useful under
 * `next dev`, pointless — and needless public surface — in any deployed build.
 */
export default function DevLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();
  return children;
}
