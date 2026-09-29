# Source readiness — 2026-09-29

The default CLI now has a live collector using the existing credentials. No
additional subscription was purchased. Raw successful responses and retrieval
times are kept in an ignored, immutable local archive without request headers.
The frozen source snapshot is also journaled in Firestore before model calls.

| Requirement | Integrated evidence | Explicit limitation |
| --- | --- | --- |
| Dated constituents | Latest Wikipedia revision at/before official close; revision 1376729338 initially matched all 503 dated SPY equity holdings | Public membership proxy, not an official S&P constituent license |
| Financial inputs | SEC company-facts, filing-date cutoff, explicit TTM periods/age and matching balance periods | Same-day date-only filings withheld; TTM ends at most 365 days earlier; incomplete debt remains unknown |
| Valuation | Massive prior-calendar-date ticker reference plus verified scoring-day share adjustments, validated ticker/CIK/USD, issuer shares expressed in the requested class's units | Provider class-equivalent valuation; different classes never summed; missing reference means null |
| Calendar | Alpaca exchange sessions | Completed close and next-entry deadline enforced |
| Official entry open | Listing-exchange condition-Q SIP trade in first minute, paginated and ambiguity checked | Missing/ambiguous auctions stay unresolved, never replaced by bar opens |
| Corporate actions | All types/qualities, complete bounded paging, 366-day process-date padding, actual ex/effective-date filtering | Provider publication delays and unsupported events remain explicit; no guarantee of exhaustive instantaneous coverage |
| Persistence | Full 20,120-row publication test with immutable chunked ID manifest | Live paid rehearsal and real production baseline are separate acceptance steps |
| Jev | Direct authenticated connection and conservative reservation accounting | Connection alone is not a full crew/tournament rehearsal |

A live AAPL return probe for 2026-09-28 identified the official open as 340.22
and the daily close as 338.40, with split factor 1 and cash 0 under the declared
provider coverage convention. It wrote no prediction or grade. The SPY dividend
probe verified why a process-date query must extend beyond the ex-date interval.
Missing, incomplete, foreign-currency or unsupported action terms are never
silently turned into zero distributions. A price-only history can disregard
cash dividends but cannot disregard share-basis changes.

Production and dry-run ledgers remain isolated. No retrospective prediction
backfill is allowed. Full-universe coverage, paid rehearsal and bootstrap
results are recorded in [VALIDATION.md](./VALIDATION.md).

Primary sources:
- [Dated constituent revision](https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&oldid=1376729338)
- [State Street SPY holdings](https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-500-etf-trust-spy)
- [SEC company-facts API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [Massive dated ticker details](https://massive.com/docs/rest/stocks/tickers/ticker-overview)
- [Massive weighted/class share definitions](https://massive.com/knowledge-base/article/what-is-the-difference-between-weighted-shares-outstanding-and-share-class-shares-outstanding)
- [Alpaca market-data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq)
- [Alpaca corporate actions](https://docs.alpaca.markets/us/reference/corporateactions-1)
