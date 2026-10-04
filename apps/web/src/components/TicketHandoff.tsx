import type { Operator } from "@busstops/contracts";
import { EXTERNAL_LINK_ATTRIBUTES, isAllowedTicketDomain, ticketLinkFor } from "../lib/tickets.js";
import "./TicketHandoff.css";

/**
 * Getting from a service to the place that sells a ticket for it, without inventing a link.
 *
 * Two sources, in this order, and nothing else is ever allowed.
 *
 * **The curated registry** (`lib/tickets.ts`) is preferred: it names the seller, records the
 * evidence and the date a human checked it, and is domain-allowlisted so one bad edit cannot ship
 * a hostile link. It is empty, deliberately, until each mapping has been verified — an unverified
 * ticket link is worse than none, because it sends a passenger somewhere wrong with our name on it.
 *
 * **The operator's own published website** is the fallback, and it is not a guess either: it is
 * `agency_url` from the operator's own GTFS feed in BODS, which is the operator telling the
 * official dataset where to find them. What it is *not* is a ticket shop, and this says so. A
 * button reading "Buy a ticket" over a link to a company's home page would be us promising
 * something we cannot see.
 *
 * Because that URL is feed text, two things guard it. Only `https` is followed — the pipeline
 * accepts `http` and a passenger should not be sent to a plaintext page from here. And the
 * hostname is shown in the link, so a poisoned feed cannot disguise where it leads.
 */

export interface TicketHandoffProps {
  operator: Operator | null;
  /** The route number, so a registry entry scoped to one service can be found. */
  routeName?: string | undefined;
  /** Heading level, so this sits correctly inside whichever page uses it. */
  headingLevel?: 2 | 3;
}

/** The hostname, for a link whose destination must be legible before it is clicked. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function TicketHandoff({ operator, routeName, headingLevel = 3 }: TicketHandoffProps) {
  if (!operator) return null;

  const registryCode = operator.licenceRegistryIds[0] ?? operator.id;
  const sold = ticketLinkFor(registryCode, routeName);

  /*
   * `https` only, and through the same allowlist check the registry uses where the host happens
   * to be on it. A host that is not on the list is still followed — it is the operator's own
   * published address and the list is about *ticket sellers* — but it is never labelled as one.
   */
  const site =
    !sold && operator.contactUrl && /^https:\/\//i.test(operator.contactUrl)
      ? operator.contactUrl
      : null;
  const siteHost = site ? hostnameOf(site) : null;

  if (!sold && !siteHost) return null;

  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <section className="ticket-handoff" aria-labelledby="ticket-handoff-heading">
      <Heading id="ticket-handoff-heading">Tickets</Heading>
      {sold ? (
        <p>
          <a className="ticket-handoff__buy" href={sold.url} {...EXTERNAL_LINK_ATTRIBUTES}>
            Buy a ticket from {sold.sellerName}
          </a>
          <span className="ticket-handoff__note small muted">
            {" "}
            Sold by {sold.sellerName}, not by us.
            {isAllowedTicketDomain(sold.url) ? "" : " This link is being reviewed."}
          </span>
        </p>
      ) : (
        <p>
          <a className="ticket-handoff__site" href={site!} {...EXTERNAL_LINK_ATTRIBUTES}>
            {operator.name} on {siteHost}
          </a>
          <span className="ticket-handoff__note small muted">
            {" "}
            The operator&apos;s own website, as they publish it in the national dataset. We do not
            know whether tickets for this service are sold there.
          </span>
        </p>
      )}
    </section>
  );
}
