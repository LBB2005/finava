"use client";
// DCF inputs for the rail and the DCF chapter, from the facts layer, so the
// sliders start from exactly the inputs behind facts.dcf. User tweaks stay local.
import { useTickerFacts } from "@/hooks/useTickerFacts";
import type { DcfInputs } from "@/lib/dcf";

export function useDcfInputs(ticker: string | null): { data: DcfInputs | undefined; error: string | undefined; isLoading: boolean; asOf: string | undefined } {
  const f = useTickerFacts(ticker);
  const dcf = f.data?.dcf;
  const pending = f.isLoading || (f.computing && !dcf?.value);
  return {
    data: dcf?.value?.inputs,
    error: pending ? undefined : dcf && !dcf.value ? dcf.note ?? "DCF is unavailable for this symbol." : f.error?.message,
    isLoading: pending,
    asOf: dcf?.asOf,
  };
}
