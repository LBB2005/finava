import { NextResponse } from "next/server";
import { adminAuth, db, serializeDoc } from "@/lib/firebase-admin";
import { requireAuth } from "@/lib/requireAuth";

/**
 * Data export (GDPR/CCPA portability; wired to Settings → Privacy & Data →
 * Export). Returns everything we hold about the user as a single downloadable
 * JSON file.
 *
 * Subcollections under users/{uid} are discovered dynamically so new features
 * are exported without anyone having to remember to update this route.
 */

// Never include credentials/tokens in an export, even the user's own.
const REDACTED_FIELDS = new Set(["accessToken", "stripeCustomerId"]);

function redact(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!REDACTED_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

export async function GET() {
  const { userId, error } = await requireAuth();
  if (error) return error;

  try {
    const userRef = db.collection("users").doc(userId);

    const [firebaseUser, settingsSnap, usageSnap, collections, memorySnap] = await Promise.all([
      adminAuth.getUser(userId).catch(() => null),
      db.collection("userSettings").doc(userId).get(),
      db.collection("userUsage").doc(userId).get(),
      userRef.listCollections(),
      // Portfolio-derived insights kept in a top-level collection, keyed by userId.
      db.collection("tickerMemory").where("userId", "==", userId).get(),
    ]);

    const data: Record<string, unknown> = {};
    for (const col of collections) {
      const snap = await col.get();
      const docs = await Promise.all(
        snap.docs.map(async (d) => {
          const doc = redact(serializeDoc(d.id, d.data()));
          // One nested level (e.g. conversations/{id}/messages) covers every
          // current subtree; deeper nesting doesn't exist in the schema.
          const subcols = await d.ref.listCollections();
          for (const sub of subcols) {
            const subSnap = await sub.get();
            doc[sub.id] = subSnap.docs.map((sd) => redact(serializeDoc(sd.id, sd.data())));
          }
          return doc;
        })
      );
      data[col.id] = docs;
    }
    data.tickerMemory = memorySnap.docs.map((d) => redact(serializeDoc(d.id, d.data())));

    const exportPayload = {
      exportedAt: new Date().toISOString(),
      account: firebaseUser
        ? {
            uid: firebaseUser.uid,
            email: firebaseUser.email ?? null,
            displayName: firebaseUser.displayName ?? null,
            photoURL: firebaseUser.photoURL ?? null,
            createdAt: firebaseUser.metadata.creationTime ?? null,
            lastSignInAt: firebaseUser.metadata.lastSignInTime ?? null,
          }
        : { uid: userId },
      settings: settingsSnap.exists ? redact(serializeDoc(userId, settingsSnap.data()!)) : null,
      usage: usageSnap.exists ? serializeDoc(userId, usageSnap.data()!) : null,
      data,
    };

    return new NextResponse(JSON.stringify(exportPayload, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="finava-export-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  } catch (err) {
    console.error("[user export]", err);
    return NextResponse.json({ error: "Failed to export data" }, { status: 500 });
  }
}
