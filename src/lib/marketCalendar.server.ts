// Server persistence is separate so horizon arithmetic remains client-safe.
import { ExchangeCalendar, type MarketSession } from "./marketCalendar";
export async function firestoreCalendar(): Promise<ExchangeCalendar> {
  const { db } = await import("./firebase-admin");
  return new ExchangeCalendar({
    cache: {
      async get(key) {
        const s = await db.collection("marketCalendarCache").doc(key).get();
        return s.exists
          ? (s.data() as { at: number; sessions: MarketSession[] })
          : null;
      },
      async put(key, value) {
        await db.collection("marketCalendarCache").doc(key).set(value);
      },
    },
  });
}
