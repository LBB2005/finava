# SEC companyfacts fixtures

Trimmed copies of real SEC XBRL `companyfacts` responses, used by
`src/lib/edgar.fixtures.test.ts` and the stock-financials route tests.

Source: `https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json`, fetched
2026-09-15. Each file keeps:

- only the tags the extraction reads (revenue, net income, cash flow, balance
  sheet, share counts, plus one annual-only tax concept),
- entries from 2022 onward, and
- the last few entries of any tag that went stale, so tests can prove we no
  longer read it (JPM's `Revenues` stops in 2014; BKNG's `NetIncomeLoss` carries
  only proxy-statement full-year figures).

Nothing is edited or synthesised — values are exactly as filed, so the expected
numbers in the tests are the filed numbers.

| File | Why it's here |
|---|---|
| `aapl.json` | Fiscal year ends late September; fiscal Q4 is never filed on its own |
| `msft.json` | Fiscal year ends 30 June; TTM at year end must equal the filed FY |
| `cost.json` | 52/53-week retail calendar with a 16-week fiscal Q4 |
| `jpm.json` | Bank tags (`RevenuesNetOfInterestExpense`); long history; concepts it stopped tagging |
| `bkng.json` | Split since the last 10-K; net income only under the "available to common" tag |

Refresh by re-fetching the URL above and re-trimming; do not hand-edit.
