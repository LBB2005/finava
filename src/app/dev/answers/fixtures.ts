/** Fixtures for the answer-UI preview page (and anything that wants a realistic
 *  contract answer to render). Numbers are illustrative fixture data — this file
 *  is never rendered outside the dev preview route. */

export const CREW_ANSWER = `## Answer
NVDA is priced for four more quarters of data-centre growth, and the reported numbers still support that. The debate is not whether demand is real — it is whether the current multiple survives the first quarter it slows.

## Key numbers
| Metric | Value | Source | As of |
| --- | --- | --- | --- |
| Price | $184.21 | Polygon | 2026-09-15 |
| Market cap | $4.52T | Polygon | 2026-09-15 |
| P/E (TTM) | 48.2 | SEC 10-Q | 2026-07-27 |
| EV/EBITDA | 41.7 | SEC 10-Q | 2026-07-27 |
| Free cash flow (TTM) | $78.4B | SEC 10-Q | 2026-07-27 |
| Short interest | Unavailable | — | — |

## Bull case
- Data-centre backlog covers roughly four quarters of revenue at current run rate
- Gross margin has held above 70% through three price cycles
- Networking attach rate is rising faster than GPU units

## Bear case
- Three hyperscalers are most of revenue, so one capex cut moves the whole thesis
- AMD's MI450 ships in Q1 into the same budget line
- The multiple leaves no room for a single missed quarter

## What would change the view
- A hyperscaler guiding 2027 capex below consensus
- Gross margin printing below 68% for two consecutive quarters

## Confidence & gaps
Medium — no options data for this ticker, and short interest did not resolve.

## Details
### Risk Analysis
Beta 1.71 against SPY over 2 years; 90-day realised volatility 46%. The position's drawdown in the March move was 31% peak to trough.

### DCF Valuation
A 10-year DCF at an 11.5% discount rate and 3% terminal growth puts fair value in a $150–$205 band, depending mostly on the 2029 margin assumption.

| Scenario | Fair value | Implied upside |
| --- | --- | --- |
| Bear | $150 | -19% |
| Base | $178 | -3% |
| Bull | $205 | +11% |

### Earnings & Catalysts
Next report is expected late November (estimated — the date is not confirmed).
`;

export const FAST_ANSWER = `## Answer
AAPL trades at 31x trailing earnings, above its own five-year median of 27x, with services revenue now a quarter of the total. Nothing in the last quarter changed the shape of the business.

## Key numbers
| Metric | Value | Source | As of |
| --- | --- | --- | --- |
| Price | $242.80 | Polygon | 2026-09-15 |
| P/E (TTM) | 31.4 | SEC 10-Q | 2026-08-01 |
| Dividend yield | 0.42% | Polygon | 2026-09-15 |

## Confidence & gaps
High — priced from live quotes and the last filed 10-Q.
`;

export const BREVITY_ANSWER = `Yes — it beat on both revenue and EPS, and raised the low end of full-year guidance.`;

export const STREAMING_ANSWER = `## Answer
NVDA is priced for four more quarters of data-centre growth, and the reported

## Key numbers
| Metric | Value | Source | As of |
| --- | --- | --- | --- |
| Price | $184.21 | Polygon | 2026-09-15 |
| P/E (TTM`;

export const LEGACY_ANSWER = `# NVDA — Full Analysis

## Technical Analysis
RSI sits at 61 and the 50-day SMA crossed above the 200-day in July.

## Summary & Recommendation
The setup remains constructive while the 200-day holds. Beta to SPY is 1.7, so position sizing matters more than entry timing here.
`;

export const BEGINNER_ANSWER = `## Answer
An ETF is a basket of investments you can buy as a single share. This one tracks the S&P 500, so its expense ratio and tracking difference matter more than any view on individual stocks.

## Confidence & gaps
High — the expense ratio is from the fund's own published sheet.
`;
