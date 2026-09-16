// src/lib/facts/format.ts
// Human as-of strings for facts: small print and hover titles. Client-safe.
import type { Fact } from "./types";

const TZ = "America/New_York";

function easternDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}

export function asOfLabel(asOf: string, now: Date = new Date()): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(asOf);
  const d = dateOnly ? new Date(`${asOf}T12:00:00.000Z`) : new Date(asOf);
  if (Number.isNaN(d.getTime())) return "as of unknown time";
  if (!dateOnly && easternDay(d) === easternDay(now)) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = String(parseInt(get("hour"), 10) % 24).padStart(2, "0");
    return `as of ${hour}:${get("minute")} ET`;
  }
  const label = new Intl.DateTimeFormat("en-US", { timeZone: dateOnly ? "UTC" : TZ, month: "short", day: "numeric" }).format(d);
  return `as of ${label}`;
}

export function factTitle<T>(f: Fact<T>, now: Date = new Date()): string {
  const parts = [f.source, asOfLabel(f.asOf, now)];
  if (f.note) parts.push(f.note);
  return parts.join(" · ");
}
