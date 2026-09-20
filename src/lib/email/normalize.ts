/**
 * The mailbox an address actually delivers to, for de-duplication.
 *
 * The waitlist sends a confirmation to every NEW address, and "new" used to mean
 * a new exact string — so `victim+1@gmail.com`, `victim+2@…`, `v.ictim@…` were all
 * new, and anyone could aim an unbounded stream of Finava-branded mail at one
 * inbox (burning the sender reputation of finava.ai on the way). Keying signups
 * on the delivering mailbox caps it at one confirmation per inbox.
 *
 * Rules: lowercase; drop a `+tag` (sub-addressing, honoured by Gmail, Outlook,
 * iCloud, Fastmail, Proton, …); for Gmail also drop dots and fold googlemail.com.
 */
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export function normalizeMailbox(email: string): string {
  const addr = email.trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at <= 0) return addr;
  let local = addr.slice(0, at);
  let domain = addr.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}
