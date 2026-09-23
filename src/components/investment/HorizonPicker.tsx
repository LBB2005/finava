"use client";

// Choosing how far out the question reaches.
//
// The horizon is the most consequential input the user controls: the same
// expected return is a Buy over one year and a Watch over two, because the hurdle
// compounds. So it is a visible, first-class control rather than a setting — and
// when no horizon was chosen, the assumed default is LABELLED, not silently
// applied.
//
// Changing the horizon starts a NEW run. It never re-labels an existing report,
// because the scenarios and the hurdle were both computed for the old horizon.

import { MAX_MONTHS, MIN_MONTHS, PRESET_MONTHS } from "@/lib/investment/horizon";

const PRESETS = [
  { label: "Short", months: PRESET_MONTHS.short },
  { label: "Medium", months: PRESET_MONTHS.medium },
  { label: "Long", months: PRESET_MONTHS.long },
] as const;

export default function HorizonPicker({
  months,
  assumed,
  disabled,
  onChange,
}: {
  months: number;
  /** True when this value is a default the user never chose. */
  assumed: boolean;
  disabled?: boolean;
  onChange: (months: number) => void;
}) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`tbtn std-focus${months === p.months ? " on" : ""}`}
            disabled={disabled}
            onClick={() => onChange(p.months)}
          >
            {p.label} · {p.months}mo
          </button>
        ))}

        <label
          className="mono"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--text-micro)", color: "var(--color-muted)" }}
        >
          <span>or</span>
          <input
            className="input std-focus"
            type="number"
            min={MIN_MONTHS}
            max={MAX_MONTHS}
            value={months}
            disabled={disabled}
            aria-label={`Horizon in months, ${MIN_MONTHS} to ${MAX_MONTHS}`}
            style={{ width: 72 }}
            onChange={(e) => {
              const next = Number(e.target.value);
              // Bounds are enforced here AND in resolveHorizon, which returns an
              // explicit `invalid` status rather than clamping to something the
              // user did not ask for.
              if (Number.isInteger(next) && next >= MIN_MONTHS && next <= MAX_MONTHS) onChange(next);
            }}
          />
          <span>months</span>
        </label>
      </div>

      {assumed && (
        <p className="mono" style={{ margin: 0, fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
          Assuming {months} months because none was specified — change it and the analysis re-runs for that horizon.
        </p>
      )}
    </div>
  );
}
