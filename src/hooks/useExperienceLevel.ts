"use client";
import useSWR from "swr";
import { authFetcher } from "@/lib/authFetch";
import {
  DEFAULT_EXPERIENCE_LEVEL,
  sanitizeExperienceLevel,
  type ExperienceLevel,
} from "@/lib/experienceLevel";

interface UserShape {
  experienceLevel?: string | null;
  /** Absent until the user has answered the first-run question. */
  experienceLevelSet?: boolean;
}

/**
 * The reader's self-reported experience, from the user doc. Shared SWR key with
 * the rest of the app, so this costs no extra request.
 */
export function useExperienceLevel(): {
  level: ExperienceLevel;
  /** False until the first-run question has been answered. */
  answered: boolean;
  loading: boolean;
  mutate: () => void;
} {
  const { data, isLoading, mutate } = useSWR<UserShape>("/api/user", authFetcher, {
    revalidateOnFocus: false,
  });

  return {
    level: data?.experienceLevel ? sanitizeExperienceLevel(data.experienceLevel) : DEFAULT_EXPERIENCE_LEVEL,
    answered: !!data?.experienceLevelSet,
    loading: isLoading,
    mutate: () => { void mutate(); },
  };
}
