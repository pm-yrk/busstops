import { Link } from "react-router-dom";
import { RAW_TRACE_MAX_AGE_HOURS_DISPLAY } from "../lib/constants.js";

/**
 * About, Privacy, Terms and Contact.
 *
 * These are required trust pages (docs/14_SECURITY.md). They state what is actually true of the
 * implementation — local-first favourites, no location logging, automatic raw-position expiry —
 * rather than boilerplate, and they avoid claims about accuracy or endorsement we cannot support.
 */

export type LegalPageName = "about" | "privacy" | "terms" | "contact";

export function LegalPages({ page }: { page: LegalPageName }) {
  switch (page) {
    case "about":
      return <AboutPage />;
    case "privacy":
      return <PrivacyPage />;
    case "terms":
      return <TermsPage />;
    case "contact":
      return <ContactPage />;
  }
}

function AboutPage() {
  return (
    <div className="page">
      <h1>About Bus Stops.</h1>
      <p style={{ maxWidth: "68ch" }}>
        Bus Stops. turns public transport data into something a passenger can act on and a transport
        professional can trust. It covers supported local bus services across England — the Bus Open
        Data Service outside London, and Transport for London within it — joined through one
        normalized model.
      </p>

      <h2>What we try to get right</h2>
      <ul style={{ maxWidth: "68ch" }}>
        <li>Show where a bus really is, and how old that information is.</li>
        <li>Explain the delay rather than only displaying it.</li>
        <li>Separate what was observed from what was inferred and what is forecast.</li>
        <li>Say when coverage is incomplete, instead of quietly showing less.</li>
        <li>Never invent data when a source fails.</li>
      </ul>

      <h2>Independence</h2>
      <p style={{ maxWidth: "68ch" }}>
        Bus Stops. is not affiliated with, or endorsed by, any bus operator, local authority,
        Transport for London or the Department for Transport. It uses their published open data
        under the licences listed in <Link to="/methodology">Data and methodology</Link>.
      </p>
    </div>
  );
}

function PrivacyPage() {
  return (
    <div className="page">
      <h1>Privacy</h1>
      <p style={{ maxWidth: "68ch" }}>
        The short version: we do not want your personal data, and the product is built so that we
        mostly never receive it.
      </p>

      <h2>Your location</h2>
      <p style={{ maxWidth: "68ch" }}>
        Location is only ever requested when you press a button that needs it, and it is used in
        your browser. “Will I make it?” calculates your walk on your device. We do not store your
        location, and it does not appear in our logs.
      </p>

      <h2>Saved stops</h2>
      <p style={{ maxWidth: "68ch" }}>
        Saved stops and routes live in your browser's own storage. There is no account, we have no
        copy, and you can export or delete everything from the <Link to="/saved">Saved</Link> page
        at any time.
      </p>

      <h2>Accounts, if you choose one</h2>
      <p style={{ maxWidth: "68ch" }}>
        An account is only needed for private preferences, organisation settings and Daily Brief
        email subscriptions. We store your email address, your preferences, and a record of your
        consent. Email is only ever sent after you confirm your address and explicitly opt in, and
        every message has a one-click unsubscribe that takes effect immediately.
      </p>

      <h2>Vehicle data</h2>
      <p style={{ maxWidth: "68ch" }}>
        Vehicle positions are public operational data. We replace operator vehicle codes with an
        opaque reference that changes daily, so nobody can follow one vehicle across days using this
        product. Raw positions are deleted automatically within {RAW_TRACE_MAX_AGE_HOURS_DISPLAY}{" "}
        hours. We do not attempt to identify drivers, and we do not present speed observations as
        evidence about any individual.
      </p>

      <h2>Analytics</h2>
      <p style={{ maxWidth: "68ch" }}>
        We do not use advertising trackers or third-party analytics that profile you. Any usage
        measurement is aggregate and carries no personal identifiers.
      </p>
    </div>
  );
}

function TermsPage() {
  return (
    <div className="page">
      <h1>Terms of use</h1>

      <h2>What this service is</h2>
      <p style={{ maxWidth: "68ch" }}>
        Bus Stops. presents public transport information and analysis derived from it. It is
        provided as-is, without warranty, for information only.
      </p>

      <h2>Accuracy</h2>
      <p style={{ maxWidth: "68ch" }}>
        Live data depends on operators' own feeds, which can be delayed, incomplete or wrong. We
        show the age and confidence of what we have so you can judge it, but we cannot guarantee
        that a bus will arrive when predicted, or at all. Do not rely on this service where being
        late would be unsafe or seriously costly.
      </p>

      <h2>Tickets</h2>
      <p style={{ maxWidth: "68ch" }}>
        We do not sell tickets. Where we link to an operator or an authorised seller, the seller is
        named, and your purchase is subject to their terms, not ours. We make no promise about
        price, availability or validity.
      </p>

      <h2>Acceptable use</h2>
      <p style={{ maxWidth: "68ch" }}>
        Please do not attempt to scrape the service in bulk, circumvent its rate limits, or use it
        to build a competing copy of the underlying feeds — the original open data is available
        directly from the publishers listed in <Link to="/methodology">Data and methodology</Link>.
      </p>

      <h2>Data licences</h2>
      <p style={{ maxWidth: "68ch" }}>
        Underlying data remains the property of its publishers and is used under the licences listed
        on the methodology page. Those licences apply to you as well when you reuse anything you see
        here.
      </p>
    </div>
  );
}

function ContactPage() {
  return (
    <div className="page">
      <h1>Contact</h1>

      <h2>Reporting a data problem</h2>
      <p style={{ maxWidth: "68ch" }}>
        If a stop, route or prediction looks wrong, it often originates upstream. Telling us which
        stop code or route number, and roughly when you saw it, is enough for us to trace it.
      </p>

      <h2>Reporting a security issue</h2>
      <p style={{ maxWidth: "68ch" }}>
        Please report suspected vulnerabilities privately and give us a reasonable window to fix the
        issue before disclosing it. Please do not run automated scanning or load testing against the
        live service: it is deliberately run inside strict free-tier limits, and testing can degrade
        it for everyone.
      </p>

      <h2>Accessibility</h2>
      <p style={{ maxWidth: "68ch" }}>
        We aim to meet WCAG 2.2 AA. If something is unusable with a keyboard, a screen reader, at
        200% zoom, or with reduced motion, that is a bug and we want to hear about it.
      </p>
    </div>
  );
}
