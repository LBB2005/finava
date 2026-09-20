"use client";
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Cell, PieChart, Pie,
} from "recharts";
import { seriesColor, gridProps, axisProps, ChartTooltip } from "@/lib/chartTheme";
import { sanitizeChartColors } from "@/lib/chartColor";

export interface ChartData {
  type: "bar" | "line" | "area" | "donut";
  title?: string;
  description?: string;
  unit?: string;
  data: Array<{ name: string; value: number; color?: string; [key: string]: unknown }>;
  series?: Array<{ key: string; color?: string; label?: string }>;
}

function fmt(val: number, unit?: string) {
  if (unit === "%" || unit === "percent") return `${val > 0 ? "+" : ""}${val.toFixed(1)}%`;
  if (unit === "$" || unit === "usd") return `$${Math.abs(val).toLocaleString()}`;
  return `${val.toLocaleString()}${unit ? ` ${unit}` : ""}`;
}

function valueColor(v: number) {
  return v >= 0 ? "var(--color-bull)" : "var(--color-bear)";
}

function BarChartView({ data, unit, series }: ChartData) {
  const isMultiSeries = series && series.length > 0;
  const isPercentage = unit === "%" || unit === "percent";

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }} barSize={isMultiSeries ? 12 : 24}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="name" {...axisProps} />
        <YAxis {...axisProps} tickFormatter={(v) => isPercentage ? `${v}%` : v} />
        <Tooltip content={<ChartTooltip formatValue={(v) => fmt(Number(v), unit)} />} />
        {isMultiSeries && <Legend wrapperStyle={{ fontSize: "var(--text-meta)" }} />}
        {isMultiSeries
          ? series!.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label ?? s.key}
                fill={s.color ?? seriesColor(i)} radius={[4, 4, 0, 0]} />
            ))
          : (
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {data.map((entry, i) => (
                <Cell key={i} fill={entry.color ?? (isPercentage ? valueColor(entry.value) : seriesColor(i))} />
              ))}
            </Bar>
          )}
      </BarChart>
    </ResponsiveContainer>
  );
}

function LineChartView({ data, unit, series }: ChartData) {
  const keys = series?.length ? series : [{ key: "value", color: seriesColor(0), label: undefined as string | undefined }];
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="name" {...axisProps} />
        <YAxis {...axisProps} />
        <Tooltip content={<ChartTooltip formatValue={(v) => fmt(Number(v), unit)} />} />
        {keys.length > 1 && <Legend wrapperStyle={{ fontSize: "var(--text-meta)" }} />}
        {keys.map((s, i) => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.label ?? s.key}
            stroke={s.color ?? seriesColor(i)} strokeWidth={2}
            dot={{ r: 3, fill: s.color ?? seriesColor(i) }} activeDot={{ r: 5 }} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function AreaChartView({ data, unit, series }: ChartData) {
  const keys = series?.length ? series : [{ key: "value", color: seriesColor(0), label: undefined as string | undefined }];
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <defs>
          {keys.map((s, i) => (
            <linearGradient key={s.key} id={`grad-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={s.color ?? seriesColor(i)} stopOpacity={0.28} />
              <stop offset="95%" stopColor={s.color ?? seriesColor(i)} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="name" {...axisProps} />
        <YAxis {...axisProps} />
        <Tooltip content={<ChartTooltip formatValue={(v) => fmt(Number(v), unit)} />} />
        {keys.length > 1 && <Legend wrapperStyle={{ fontSize: "var(--text-meta)" }} />}
        {keys.map((s, i) => (
          <Area key={s.key} type="monotone" dataKey={s.key} name={s.label ?? s.key}
            stroke={s.color ?? seriesColor(i)} strokeWidth={2}
            fill={`url(#grad-${i})`} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function DonutChartView({ data, unit }: ChartData) {
  const total = data.reduce((s, d) => s + Math.abs(d.value), 0);
  return (
    <div className="flex items-center gap-6">
      <ResponsiveContainer width={160} height={160}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={48} outerRadius={72}
            dataKey="value" strokeWidth={2} stroke="var(--color-bg)" paddingAngle={2}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.color ?? seriesColor(i)} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip formatValue={(v) => fmt(Number(v), unit)} />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="flex flex-col gap-1.5 min-w-0">
        {data.map((entry, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: entry.color ?? seriesColor(i) }} />
            <span className="text-[length:var(--text-sm)] font-semibold text-[var(--color-text)] w-16 truncate">{entry.name}</span>
            <span className="mono text-[length:var(--text-sm)] text-[var(--color-muted)]">
              {total > 0 ? `${((Math.abs(entry.value) / total) * 100).toFixed(1)}%` : fmt(entry.value, unit)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ChartBlock({ raw }: { raw: string }) {
  let chart: ChartData;
  try {
    chart = JSON.parse(raw) as ChartData;
    if (!chart.data || !Array.isArray(chart.data)) throw new Error("invalid");
    // Model-written colours reach CSS; strip anything that could fetch a URL.
    chart = sanitizeChartColors(chart);
  } catch {
    return (
      <div
        className="my-3 p-3 text-[length:var(--text-sm)]"
        style={{
          borderRadius: "var(--radius-md)",
          border: "1px solid color-mix(in oklab, var(--color-bear) 35%, transparent)",
          background: "color-mix(in oklab, var(--color-bear) 8%, transparent)",
          color: "var(--color-bear)",
        }}
      >
        Invalid chart data
      </div>
    );
  }

  return (
    <div className="card my-4 overflow-hidden">
      {(chart.title || chart.description) && (
        <div className="px-4 pt-3.5 pb-2 border-b border-[var(--color-border)]">
          {chart.title && <p className="text-[length:var(--text-sm)] font-semibold text-[var(--color-text)]">{chart.title}</p>}
          {chart.description && <p className="text-[length:var(--text-meta)] text-[var(--color-muted)] mt-0.5">{chart.description}</p>}
        </div>
      )}
      <div className="px-4 py-4">
        {chart.type === "bar" && <BarChartView {...chart} />}
        {chart.type === "line" && <LineChartView {...chart} />}
        {chart.type === "area" && <AreaChartView {...chart} />}
        {chart.type === "donut" && <DonutChartView {...chart} />}
      </div>
    </div>
  );
}
