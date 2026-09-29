# Source readiness — 2026-09-29

These are read-only provider probes, not a live tournament run. Credentials were
read from ignored local configuration and never recorded in output. No new API
subscription was purchased and no production prediction was written.

| Requirement | Observed evidence | Remaining limitation |
| --- | --- | --- |
| Dated constituents | Wikipedia revision 1376729338, published 2026-09-25T22:49:33Z, contains 503 distinct members with CIKs; every ticker matches the 503 equities in State Street's SPY holdings dated 25-Sep-2026 | Public dated revision and ETF corroboration, not an official S&P membership contract; no production archive producer connected |
| Dated financial inputs | SEC AAPL company-facts returns filing dates; cutoff filtering and trailing-period derivation have focused tests | Full-universe availability and missingness have not been measured; derivation helpers are not wired into live ingestion |
| Polygon financials | Dated TTM endpoint returned HTTP 200 | Examined response has fiscal start/end but no filing timestamp; cannot label period dates as availability dates |
| Calendar | Alpaca calendar returned exchange sessions | Already integrated; no additional calendar key needed |
| Official opening trade | Historical SIP request for AAPL on 2026-09-25 returned an opening-condition Q trade at the open | One observation is not proof of all-universe official entry coverage; listing exchange identification and missing/ambiguous cases still need a collector |
| Corporate actions | NVDA's 2024-06-10 split returned its 10:1 terms; SPY's 2026-09-18 dividend returned amount 1.888834 when the process-date interval included 2026-10-30 | Queries filter process date, not ex-date; a same-window empty result cannot certify no dividends. Full paging, event-date filtering, unsupported events and raw evidence preservation remain required |
| Persistence | Read-only query of the Firestore dry-run namespace succeeded | Does not establish a completed paid dry run or production ledger write |
| Jev | Direct API connection succeeded; see VALIDATION.md | Connectivity is not a full crew/tournament rehearsal |

Alpaca's `data_quality=all` includes incomplete actions; those must remain
explicit unknowns. Even `data_quality=complete` is a record-completeness filter,
not an assurance of immediate availability: the provider documents processing
delays. A collector must handle those limits rather than turn missing records
into known zero distributions.

`collectionInputs.ts` provides preparatory pure functions for revision parsing,
SEC filing-cutoff inputs, split-aware observed price inputs and sector peers.
They are not invoked by `DatedSources`; the live commands still require a
verified `TOURNAMENT_DATA_DIR` or `TOURNAMENT_DATA_URL` archive. Do not set
`verified`, `coverageConfirmed` or `actionsComplete` just because HTTP succeeded.

Activation remains blocked on that integrated archive, a prospective paid
rehearsal and a genuine baseline. No source or API-key success should be reported
as completion of the live tournament.

Primary sources:
- [Dated constituent revision](https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&oldid=1376729338)
- [State Street SPY holdings](https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-500-etf-trust-spy)
- [SEC company-facts API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [Alpaca market-data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq)
- [Alpaca corporate actions](https://docs.alpaca.markets/us/reference/corporateactions-1)
