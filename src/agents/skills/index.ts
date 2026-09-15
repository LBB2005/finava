import type { AgentSkill } from "./types";
import { DATA_ACCURACY_RULE } from "@/lib/dataAccuracy";
import { promptClockLine } from "@/lib/promptClock";
import riskSkill from "./risk";
import newsSkill from "./news";
import macroSkill from "./macro";
import technicalSkill from "./technical";
import dcfSkill from "./dcf";
import earningsSkill from "./earnings";
import insiderSkill from "./insider";
import sentimentSkill from "./sentiment";
import competitorSkill from "./competitor";
import optionsSkill from "./options";
import comparablesSkill from "./comparables";
import grahamSkill from "./graham";
import analystSkill from "./analyst";
import hypeSkill from "./hype";
import fundamentalsSkill from "./fundamentals";

export type { AgentSkill };

const SKILLS: Record<string, AgentSkill> = {
  risk:         riskSkill,
  news:         newsSkill,
  macro:        macroSkill,
  technical:    technicalSkill,
  dcf:          dcfSkill,
  earnings:     earningsSkill,
  insider:      insiderSkill,
  sentiment:    sentimentSkill,
  competitor:   competitorSkill,
  options:      optionsSkill,
  comparables:  comparablesSkill,
  graham:       grahamSkill,
  analyst:      analystSkill,
  hype:         hypeSkill,
  fundamentals: fundamentalsSkill,
};

// Agents whose output is wrong without today's date: earnings (reported vs.
// upcoming quarters, estimated dates), news (recency), macro (market status).
const DATE_SENSITIVE = new Set(["earnings", "news", "macro"]);

/**
 * Returns a formatted system prompt block for the given agent name.
 * Inject this as `system:` in each sub-agent's anthropic.messages.create() call.
 */
export function getSkillsPrompt(name: string): string {
  const s = SKILLS[name];
  if (!s) return "";
  return [
    `## Your Identity\n${s.persona}`,
    `## Your Strengths\n${s.strengths.map((x) => `- ${x}`).join("\n")}`,
    `## Analytical Guidelines\n${s.promptEnhancements.map((x) => `- ${x}`).join("\n")}`,
    `## Domain Patterns\n${s.learnedPatterns.map((x) => `- ${x}`).join("\n")}`,
    DATE_SENSITIVE.has(name)
      ? `## Today\n${promptClockLine()} A fiscal period that has ended is reported, not projected; label an unconfirmed earnings date "(estimated)".`
      : "",
    DATA_ACCURACY_RULE,
  ].filter(Boolean).join("\n\n");
}
