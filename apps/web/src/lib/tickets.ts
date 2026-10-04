/**
 * Ticket link registry (docs/05_DATA_SOURCES.md "Ticket links", docs/14_SECURITY.md T5).
 *
 * Two hard rules, both enforced here rather than at call sites:
 *  - A ticket URL is only ever taken from this curated registry. URLs are never constructed
 *    from feed text, which is what closes the SSRF and open-redirect path.
 *  - Every entry names the seller, records the evidence and the date it was verified, and can
 *    be deactivated without a code change to the callers.
 */

import sellerData from "../../../../data/ticket-sellers.json";

export interface TicketRegistryEntry {
  /** National Operator Code or internal operator id this applies to. */
  operatorCode: string;
  operatorName: string;
  /** Seller shown to the user, so an external seller is never mistaken for us. */
  sellerName: string;
  url: string;
  /** Route numbers this applies to; empty means the operator's whole network. */
  routeNames: string[];
  evidence: string;
  verifiedAt: string | null;
  active: boolean;
}

/**
 * A ticket seller: a domain, and the page on it that was found to sell tickets.
 *
 * An entry is only usable once `url` and `verifiedAt` are filled in from a check that actually
 * ran. `scripts/verify-ticket-links.mjs` fetches the candidates from a CI runner — this
 * repository's agent has no outbound route to operator sites — and reports what each one served,
 * including the page title. The result is written back into `data/ticket-sellers.json`
 * deliberately, so no link reaches a passenger without someone having read the evidence.
 */
export interface TicketSeller {
  domain: string;
  sellerName: string;
  candidatePaths: string[];
  url: string | null;
  pageTitle: string | null;
  verifiedAt: string | null;
  evidence: string | null;
}

export const TICKET_SELLERS: readonly TicketSeller[] = (sellerData as { sellers: TicketSeller[] })
  .sellers;

/**
 * Domains a ticket link may point at, derived from the seller list rather than kept in step with
 * it by hand. A registry entry pointing anywhere else is refused even if it was added by mistake,
 * so one bad edit cannot ship a hostile link.
 */
export const TICKET_DOMAIN_ALLOWLIST: readonly string[] = TICKET_SELLERS.flatMap((seller) => [
  seller.domain,
  `www.${seller.domain}`,
]);

/**
 * Deliberately empty until each mapping has been verified against the operator's own site.
 * An unverified ticket link is worse than none: it sends a passenger to the wrong place with
 * our name on it. `verifiedAt` must be set by a human check before an entry is activated.
 */
export const TICKET_REGISTRY: readonly TicketRegistryEntry[] = [];

export function isAllowedTicketDomain(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return TICKET_SELLERS.some((seller) => isOnDomain(parsed.hostname, seller.domain));
  } catch {
    return false;
  }
}

/**
 * Exact domain or a subdomain of it. Never a plain suffix match: `endsWith("firstbus.co.uk")`
 * is also true of `notfirstbus.co.uk`, which is how an attacker-registered lookalike would get
 * itself onto an allowlist.
 */
export function isOnDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const base = domain.toLowerCase();
  return host === base || host.endsWith(`.${base}`);
}

/**
 * The seller for an operator, matched on the domain **the operator themselves publishes**.
 *
 * This is the part worth being careful about. Keying tickets off a National Operator Code would
 * mean keeping a table of which subsidiary belongs to which group — and a wrong row there sends a
 * passenger to a competitor's shop with our name on it. `contactUrl` is `agency_url` from the
 * operator's own GTFS feed in BODS: the operator telling the national dataset where to find them.
 * So if First Leeds publishes `firstbus.co.uk`, First Bus is their seller by their own account,
 * and nothing had to be remembered or guessed.
 */
export function sellerForOperatorSite(contactUrl: string | undefined): TicketSeller | null {
  return findSeller(TICKET_SELLERS, contactUrl);
}

/**
 * The same decision against a given seller list, so both polarities can be tested: the live list
 * is whatever has been verified so far, and a test that can only ever see "nothing verified yet"
 * would pass just as happily if the matching were broken.
 */
export function findSeller(
  sellers: readonly TicketSeller[],
  contactUrl: string | undefined,
): TicketSeller | null {
  if (!contactUrl) return null;
  let hostname: string;
  try {
    const parsed = new URL(contactUrl);
    // The pipeline accepts http; a passenger is not sent from here to a plaintext page.
    if (parsed.protocol !== "https:") return null;
    hostname = parsed.hostname;
  } catch {
    return null;
  }
  return (
    sellers.find(
      (seller) =>
        seller.url !== null && seller.verifiedAt !== null && isOnDomain(hostname, seller.domain),
    ) ?? null
  );
}

export interface TicketLink {
  url: string;
  sellerName: string;
  operatorName: string;
}

/**
 * The ticket link for an operator and route, or null. Returning null is the normal case while
 * the registry is unverified, and callers show the operator's information instead.
 */
export function ticketLinkFor(operatorCode: string, routeName?: string): TicketLink | null {
  const entry = TICKET_REGISTRY.find(
    (candidate) =>
      candidate.active &&
      candidate.verifiedAt !== null &&
      candidate.operatorCode === operatorCode &&
      (candidate.routeNames.length === 0 ||
        (routeName !== undefined && candidate.routeNames.includes(routeName))),
  );

  if (!entry || !isAllowedTicketDomain(entry.url)) return null;

  return { url: entry.url, sellerName: entry.sellerName, operatorName: entry.operatorName };
}

/** Attributes every external ticket link must carry. */
export const EXTERNAL_LINK_ATTRIBUTES = {
  target: "_blank",
  rel: "noopener noreferrer external",
} as const;
