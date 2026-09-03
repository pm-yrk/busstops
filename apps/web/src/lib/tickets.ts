/**
 * Ticket link registry (docs/05_DATA_SOURCES.md "Ticket links", docs/14_SECURITY.md T5).
 *
 * Two hard rules, both enforced here rather than at call sites:
 *  - A ticket URL is only ever taken from this curated registry. URLs are never constructed
 *    from feed text, which is what closes the SSRF and open-redirect path.
 *  - Every entry names the seller, records the evidence and the date it was verified, and can
 *    be deactivated without a code change to the callers.
 */

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
 * Domains a ticket link may point at. A registry entry whose URL is not on this list is
 * refused even if it was added by mistake, so one bad edit cannot ship a hostile link.
 */
export const TICKET_DOMAIN_ALLOWLIST: readonly string[] = [
  "www.firstbus.co.uk",
  "www.stagecoachbus.com",
  "www.arrivabus.co.uk",
  "www.goaheadbus.com",
  "tfl.gov.uk",
  "www.nationalexpress.com",
];

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
    return TICKET_DOMAIN_ALLOWLIST.includes(parsed.hostname);
  } catch {
    return false;
  }
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
