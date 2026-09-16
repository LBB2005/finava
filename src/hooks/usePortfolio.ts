"use client";
import { useCallback, useState } from "react";
import useSWR from "swr";
import type { Holding } from "@/types/portfolio";
import { authFetch, authFetcher } from "@/lib/authFetch";
import { useAuth } from "@/context/AuthContext";
import { usePlaidStatus } from "@/hooks/usePlaidStatus";
import { DEV_HOLDINGS, DEV_CASH } from "@/lib/devPortfolio";
import { addToPosition, replacePosition, type PositionInput } from "@/lib/holdings";

/** How a re-added ticker folds into the position you already hold. */
export type MergeMode = "add" | "replace";

/** Set once the user clears the seeded sample book, so it doesn't come back. */
const SAMPLE_DISMISSED_KEY = "finava_sample_portfolio_dismissed";

function sampleDismissedInitially(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(SAMPLE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function usePortfolio() {
  // Under the dev auth bypass the "dev-bypass" sentinel still authenticates
  // server-side (requireAuth maps it to uid "dev-user" outside production), so
  // we CAN read the real Firestore book. We fetch it and fall back to the seeded
  // mock only when that book is empty — this keeps the default design-time DX
  // (mock shows) while letting Plaid-synced holdings appear once imported.
  const { devBypass } = useAuth();
  const { plaidConnected, plaidInstitutions, mutatePlaidStatus } = usePlaidStatus();
  const [sampleDismissed, setSampleDismissed] = useState(sampleDismissedInitially);

  const { data, error, isLoading, mutate } = useSWR<Holding[]>(
    "/api/portfolio",
    authFetcher,
    { revalidateOnFocus: false }
  );

  const { data: settingsData, mutate: mutateSettings } = useSWR<{ cashBalance: number }>(
    "/api/portfolio/settings",
    authFetcher,
    { revalidateOnFocus: false }
  );

  async function setCashBalance(cashBalance: number) {
    await authFetch("/api/portfolio/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cashBalance }),
    });
    await mutateSettings();
  }

  async function addHolding(holding: Omit<Holding, "id" | "createdAt" | "updatedAt">) {
    const res = await authFetch("/api/portfolio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(holding),
    });
    if (!res.ok) throw new Error("Failed to add holding");
    await mutate();
  }

  async function removeHolding(id: string) {
    const res = await authFetch(`/api/portfolio/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to remove holding");
    await mutate();
  }

  /** Edit an existing position in place — share count and per-share cost basis. */
  async function updateHolding(
    id: string,
    patch: { shares?: number; avgCost?: number; companyName?: string | null; sector?: string | null }
  ) {
    const res = await authFetch(`/api/portfolio/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error("Failed to update holding");
    await mutate();
  }

  async function uploadCsv(file: File): Promise<{ imported: number; failed: number }> {
    const form = new FormData();
    form.append("file", file);
    const res = await authFetch("/api/portfolio/csv", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Upload failed");
    await mutate();
    return data;
  }

  /** Revalidate holdings, cash, and connection status — e.g. after a Plaid sync. */
  async function refresh() {
    await Promise.all([mutate(), mutateSettings(), mutatePlaidStatus()]);
  }

  /** Re-pull the linked brokerage(s) and rebuild the book. */
  async function syncPlaid() {
    const res = await authFetch("/api/plaid/sync", { method: "POST" });
    if (!res.ok) throw new Error("Failed to sync");
    await refresh();
  }

  /** Disconnect Plaid — keeps holdings but converts them to editable manual entries. */
  async function disconnectPlaid() {
    const res = await authFetch("/api/plaid/disconnect", { method: "POST" });
    if (!res.ok) throw new Error("Failed to disconnect");
    await refresh();
  }

  const realHoldings = Array.isArray(data) ? data : [];
  const useMockHoldings = devBypass && realHoldings.length === 0 && !sampleDismissed;

  /** The position already on file for this ticker, if any. */
  const findHolding = useCallback(
    (ticker: string) =>
      realHoldings.find((h) => h.ticker.toUpperCase() === ticker.trim().toUpperCase()) ?? null,
    // realHoldings is rebuilt each render from SWR's cached array; key off that array.
    [data] // eslint-disable-line react-hooks/exhaustive-deps
  );

  /**
   * Re-add a ticker already in the book. `mode` decides whether the entered lot
   * is folded into the position (share-weighted cost basis) or replaces it —
   * it is never applied silently.
   */
  async function mergeHolding(existing: Holding, incoming: PositionInput, mode: MergeMode) {
    const next = mode === "add" ? addToPosition(existing, incoming) : replacePosition(existing, incoming);
    await updateHolding(existing.id, next);
    return next;
  }

  /** Drop the seeded sample book and fall through to the real (empty) portfolio. */
  function clearSampleHoldings() {
    try {
      localStorage.setItem(SAMPLE_DISMISSED_KEY, "1");
    } catch {
      /* private mode — the flag just won't persist across reloads */
    }
    setSampleDismissed(true);
  }

  return {
    holdings: useMockHoldings ? DEV_HOLDINGS : realHoldings,
    cashBalance: useMockHoldings && settingsData?.cashBalance == null
      ? DEV_CASH
      : (settingsData?.cashBalance ?? 0),
    error,
    isLoading,
    mutate,
    refresh,
    addHolding,
    removeHolding,
    updateHolding,
    findHolding,
    mergeHolding,
    uploadCsv,
    setCashBalance,
    /** True while the seeded design-time book is standing in for a real one. */
    isSampleData: useMockHoldings,
    clearSampleHoldings,
    // Plaid
    plaidConnected,
    plaidInstitutions,
    syncPlaid,
    disconnectPlaid,
  };
}
