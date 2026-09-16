/**
 * The prompt for an explicit "Run full analysis".
 *
 * The button re-asks the question the fast lane just answered, and that answer
 * is in the transcript the crew receives (one transcript, W1-1). Left to itself
 * the CEO sees it has just answered this exact question and replies with a
 * recap — observed on merged main: "I already ran a full analysis on MSFT …
 * here's a quick recap", with zero of the four planned agents run. The user
 * pressed the button precisely because the short answer was not enough, so the
 * escalation has to be stated in the turn itself.
 */
export function fullAnalysisPrompt(question: string): string {
  const q = question.trim();
  if (!q) return "";
  return `${q}

[The user read a short answer to this and has explicitly asked for the full multi-agent analysis. Deploy the crew and write the full report from what they gather. Do not summarise or refer back to the previous short answer — go deeper than it did.]`;
}
