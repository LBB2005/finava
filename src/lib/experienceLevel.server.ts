import { db } from "@/lib/firebase-admin";
import {
  DEFAULT_EXPERIENCE_LEVEL,
  sanitizeExperienceLevel,
  type ExperienceLevel,
} from "@/lib/experienceLevel";

/**
 * The reader's experience level, read from the user doc rather than trusted
 * from the request — prompts change what they explain based on it, so it is
 * server-authoritative like every other user setting.
 *
 * Never throws: an unreadable setting falls back to the default.
 */
export async function getExperienceLevel(userId: string | undefined): Promise<ExperienceLevel> {
  if (!userId) return DEFAULT_EXPERIENCE_LEVEL;
  try {
    const doc = await db.collection("userSettings").doc(userId).get();
    return sanitizeExperienceLevel(doc.exists ? doc.data()?.experienceLevel : undefined);
  } catch {
    return DEFAULT_EXPERIENCE_LEVEL;
  }
}
