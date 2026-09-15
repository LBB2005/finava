import { pricingTiers, trialLine } from "@/lib/pricingCopy";

// Copy is generated from plans.ts (credits, run caps, capabilities) so the page
// can't advertise "Unlimited" on a metered plan or perks the code doesn't ship.
const TIERS = pricingTiers();

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 mt-0.5 text-[var(--lp-accent-2)]">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export default function Pricing() {
  return (
    <section id="pricing" className="max-w-[1140px] mx-auto px-5 sm:px-8 py-24 md:py-28">
      <div className="max-w-2xl mx-auto text-center mb-14">
        <span className="lp-eyebrow text-[var(--lp-accent-2)]">Pricing</span>
        <h2 className="lp-display mt-3 text-[clamp(1.9rem,4vw,2.8rem)] font-bold text-[var(--lp-text)]">
          Institutional-grade research. Individual pricing.
        </h2>
      </div>

      <div className="grid gap-5 md:grid-cols-3 items-start">
        {TIERS.map((t) => (
          <div
            key={t.name}
            className={`rounded-2xl p-6 relative ${
              t.featured
                ? "border-2 border-[var(--lp-accent)] bg-[var(--lp-surface)] shadow-[0_24px_60px_-30px_rgba(77,156,248,0.6)] lg:-mt-3 lg:mb-3"
                : "lp-card"
            }`}
          >
            {t.featured && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[11px] font-bold uppercase tracking-wider text-[#070b16] bg-[var(--lp-accent)] px-3 py-1 rounded-full">
                Most popular
              </span>
            )}
            <h3 className="text-[15px] font-semibold text-[var(--lp-text-secondary)] uppercase tracking-wide">
              {t.name}
            </h3>
            <div className="mt-3 flex items-baseline gap-1.5">
              <span className="lp-display text-[2.1rem] font-black text-[var(--lp-text)]">
                {t.price}
              </span>
              {t.cadence && (
                <span className="text-[15px] text-[var(--lp-muted)]">{t.cadence}</span>
              )}
            </div>
            {t.annual ? (
              <p className="mt-1 text-[12.5px] text-[var(--lp-muted)]">{t.annual}</p>
            ) : (
              <p className="mt-1 text-[12.5px] text-[var(--lp-muted)]">&nbsp;</p>
            )}
            <p className="mt-4 text-[14px] text-[var(--lp-text-secondary)]">{t.blurb}</p>

            <a
              href="#waitlist"
              className={`mt-6 block text-center text-[14px] font-semibold px-5 py-3 rounded-xl transition-colors ${
                t.featured
                  ? "text-[#070b16] bg-[var(--lp-accent)] hover:bg-[var(--lp-accent-2)]"
                  : "text-[var(--lp-text)] border border-[var(--lp-border-strong)] hover:bg-[var(--lp-surface-2)]"
              }`}
            >
              {t.cta}
            </a>

            <ul className="mt-7 space-y-3">
              {t.features.map((f) => (
                <li key={f} className="flex gap-2.5 text-[13.5px] text-[var(--lp-text-secondary)]">
                  <Check />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="mt-10 text-center text-[13px] text-[var(--lp-muted)]">
        {trialLine()}
      </p>
      <p className="mt-2 text-center text-[12px] text-[var(--lp-muted)] italic max-w-2xl mx-auto">
        Finava is a research tool, not a financial advisor. All outputs are for informational
        purposes and do not constitute investment advice.
      </p>
    </section>
  );
}
