import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

/**
 * Server-only Plaid client. Configured from env:
 *   PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox | production)
 *
 * Never import this from a "use client" module — the secret must stay on the
 * server. All Plaid calls live behind /api/plaid/* route handlers.
 */
function resolveBasePath(): string {
  const env = (process.env.PLAID_ENV ?? "sandbox").toLowerCase();
  if (env === "production") return PlaidEnvironments.production;
  return PlaidEnvironments.sandbox;
}

const configuration = new Configuration({
  basePath: resolveBasePath(),
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});

export const plaidClient = new PlaidApi(configuration);

/** True when Plaid env vars are present — lets routes fail loudly with a clear message. */
export function plaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

/**
 * Most brokerage connections (Plaid Items) one user may hold. Plaid bills per
 * Item per month, and nothing used to stop one account linking the same
 * brokerage over and over — each link a new billed Item that outlived any trial.
 */
export const MAX_PLAID_ITEMS = 5;

export function plaidItemLimitReached(existingItems: number): boolean {
  return existingItems >= MAX_PLAID_ITEMS;
}
