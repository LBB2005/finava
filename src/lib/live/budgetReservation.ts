// Request admission, shared by the daily tournament's model arms. Reservations
// are never released on a timeout: the provider may already have billed it.
export interface SpendReservation {
  id: string;
  upperUsd: number;
  measuredUsd: number | null;
}
export interface ReservationStore {
  reserve(id: string, upperUsd: number, cap: number): Promise<boolean>;
  measure(id: string, usd: number | null): Promise<void>;
  entries(): Promise<SpendReservation[]>;
}
export function tournamentCap(
  raw = process.env.TOURNAMENT_DAILY_USD_CAP,
): number {
  if (raw === undefined) return 8;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new Error("Invalid TOURNAMENT_DAILY_USD_CAP");
  return value;
}
export class MemoryReservations implements ReservationStore {
  private values = new Map<string, SpendReservation>();
  async reserve(id: string, upperUsd: number, cap: number) {
    validateReservation(upperUsd, cap);
    if (this.values.has(id)) return false;
    if (
      [...this.values.values()].some(
        (r) => r.measuredUsd !== null && r.measuredUsd > r.upperUsd,
      )
    )
      return false;
    if (
      [...this.values.values()].reduce((s, r) => s + r.upperUsd, 0) + upperUsd >
      cap
    )
      return false;
    this.values.set(id, { id, upperUsd, measuredUsd: null });
    return true;
  }
  async measure(id: string, usd: number | null) {
    const r = this.values.get(id);
    if (!r) throw new Error("Unknown reservation");
    validateMeasurement(usd);
    r.measuredUsd = usd;
  }
  async entries() {
    return structuredClone([...this.values.values()]);
  }
}
export function validateReservation(usd: number, cap: number) {
  if (!Number.isFinite(usd) || usd <= 0 || !Number.isFinite(cap) || cap < 0)
    throw new Error("Invalid reservation");
}
export function validateMeasurement(usd: number | null) {
  if (usd !== null && (!Number.isFinite(usd) || usd < 0))
    throw new Error("Invalid measured cost");
}
