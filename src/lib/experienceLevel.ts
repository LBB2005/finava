/**
 * How much investing vocabulary the reader already has. Asked once at first run,
 * changeable in Settings, stored on the user doc as `experienceLevel`.
 *
 * It only ever changes how much is explained — never which numbers are shown.
 */
export const EXPERIENCE_LEVELS = ["beginner", "intermediate", "professional"] as const;

export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

/** What a user who has never answered the question gets. */
export const DEFAULT_EXPERIENCE_LEVEL: ExperienceLevel = "intermediate";

export const EXPERIENCE_LABELS: Record<ExperienceLevel, string> = {
  beginner: "New to investing",
  intermediate: "Some experience",
  professional: "Professional",
};

export const EXPERIENCE_BLURBS: Record<ExperienceLevel, string> = {
  beginner: "Jargon is underlined and explained in plain English.",
  intermediate: "Terms are explained when they are less common.",
  professional: "No explanations — the numbers as written.",
};

/** Accept only a known level; anything else falls back to the default. */
export function sanitizeExperienceLevel(value: unknown): ExperienceLevel {
  return EXPERIENCE_LEVELS.includes(value as ExperienceLevel)
    ? (value as ExperienceLevel)
    : DEFAULT_EXPERIENCE_LEVEL;
}

/** One line the prompts can paste in so the answer matches the reader. */
export function experiencePromptLine(level: ExperienceLevel | undefined): string {
  switch (sanitizeExperienceLevel(level)) {
    case "beginner":
      return "The reader is new to investing: define any term beyond price and shares in plain English the first time you use it, and keep sentences short.";
    case "professional":
      return "The reader is a professional investor: use standard finance vocabulary without defining it, and lead with the numbers.";
    default:
      return "The reader has some investing experience: use common terms freely, but explain anything specialised the first time it appears.";
  }
}
