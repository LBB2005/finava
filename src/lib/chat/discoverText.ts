import type { DiscoverMessageContent } from "@/lib/scoutTypes";

const KINDS = new Set(["shortlist", "wave", "final"]);

/** Parse a Discover payload stored as JSON (legacy `content`, or `attachment`). */
export function parseDiscoverContent(raw: string | undefined | null): DiscoverMessageContent | null {
  if (!raw || raw[0] !== "{") return null;
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown };
    return parsed && typeof parsed.kind === "string" && KINDS.has(parsed.kind)
      ? (parsed as DiscoverMessageContent)
      : null;
  } catch {
    return null;
  }
}

/**
 * Readable text for a Discover result. This is what goes in `content`, so the
 * model sees a ranked list (not JSON) when it reads the transcript back.
 */
export function discoverToMarkdown(dc: DiscoverMessageContent): string {
  switch (dc.kind) {
    case "shortlist": {
      const ranked = [...dc.picks].sort((a, b) => a.fitRank - b.fitRank);
      const lines = ranked.map((p, i) => `${i + 1}. **${p.ticker}** (${p.name})${p.reason ? ` — ${p.reason}` : ""}`);
      return [
        `Shortlist for "${dc.query}" (${dc.tier}):`,
        dc.framing?.trim() ?? "",
        lines.join("\n"),
      ].filter(Boolean).join("\n\n");
    }
    case "wave":
      return `Crew wave ${dc.wave.waveIndex + 1} of ${dc.totalWaves} analyzed: ${dc.wave.tickers.join(", ")}.`;
    case "final":
      return dc.report;
  }
}
