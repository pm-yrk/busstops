import { Link } from "react-router-dom";
import { Wordmark } from "../components/Wordmark.js";
import { PixelStreetScene } from "../components/pixel/PixelStreetScene.js";
import "./HomePage.css";

/**
 * Home (docs/03_SITE_MAP_AND_UX.md "Page requirements").
 *
 * The first viewport holds the wordmark, the street scene and one scroll cue. Nothing else: the
 * mark and the artwork are the whole idea of the product, and a paragraph and two buttons beside
 * them turn a statement into a landing page. The promise and the ways in follow immediately
 * below, where someone who has scrolled is actually looking for them.
 *
 * Everything is in the DOM from the start, so keyboard and screen-reader users are never waiting
 * on an animation or a scroll position to reach the content.
 */

export function HomePage() {
  return (
    <div className="home">
      <section className="home__hero" aria-label="Bus Stops.">
        <div className="home__hero-top">
          <Wordmark variant="stacked" size="hero" as="h1" />

          {/*
           * A cue rather than a control: the page scrolls normally, and an arrow that looked like
           * a button would promise behaviour it does not have.
           */}
          <div className="home__scroll-cue" aria-hidden="true">
            <span className="home__scroll-cue-text">Scroll</span>
            <span className="home__scroll-cue-line" />
          </div>
        </div>

        {/* Full-bleed: the street runs off both edges, so it reads as a street and not a card. */}
        <PixelStreetScene className="home__hero-scene" />
      </section>

      <section className="home__intro page">
        <p className="home__promise">
          Know where your bus really is, what is delaying it, and what to do next.
        </p>

        <div className="home__cta-row">
          <Link to="/live" className="button-primary home__cta">
            Open the live map
          </Link>
          <Link to="/search" className="home__cta-secondary">
            Or search for a stop
          </Link>
        </div>
      </section>

      <section className="home__section page" aria-labelledby="home-live-heading">
        <h2 id="home-live-heading">Bus Stops Live</h2>
        {/*
          What the deployment actually does, not what the architecture allows.

          This said "inside and outside London", and then said London's live vehicle feed was "not
          yet proven" — which frames a permanent property of the source as a temporary gap. TfL's
          Unified API does not publish vehicle positions at all; `deriveLondonVehiclePosition` in
          the adapter says so in as many words, and the live service leaves the London vehicle
          layer deliberately empty. There will never be a bus on the map in London, and waiting for
          one to be "proven" is waiting for something that is not coming. What London does have is
          live arrival predictions at every stop, which is the thing a passenger actually wanted.
        */}
        <p className="home__lede">
          Live vehicle positions, real arrivals and the reasoning behind them, across England
          outside London. In London it is the other way round: Transport for London publishes when
          each bus will arrive rather than where it is now, so there are live arrivals at the stops
          and no buses on the map — and the map says so instead of looking empty.
        </p>

        <div className="grid-cards">
          <article className="surface home__card">
            <h3>Where the bus actually is</h3>
            <p className="muted">
              See the vehicle on the map with the age of its last position, its delay against the
              timetable, and its next stops. When we are unsure, we say so instead of guessing.
            </p>
          </article>
          <article className="surface home__card">
            <h3>Which stop to use</h3>
            <p className="muted">
              The nearest stop is not always the fastest. The journey planner compares candidates
              and explains why the recommended one wins, with a range rather than false precision.
            </p>
          </article>
          <article className="surface home__card">
            <h3>When something goes wrong</h3>
            <p className="muted">
              <strong>Bus Stopped?</strong> gathers what is actually known — the last reliable
              position, whether other buses nearby are moving, and any official notice — and lists
              candidates rather than picking a reason. Where it knows nothing, it says that.
            </p>
          </article>
        </div>
      </section>

      <section className="home__section page" aria-labelledby="home-pro-heading">
        <h2 id="home-pro-heading">Bus Stops Pro</h2>
        <p className="home__lede">
          Network health, punctuality, reliability, congestion and abnormality analysis for
          transport professionals. The demo is public and needs no sign-in.
        </p>
        <Link to="/pro" className="button-primary home__cta">
          Explore the Pro demo
        </Link>
      </section>

      <section className="home__section page" aria-labelledby="home-trust-heading">
        <h2 id="home-trust-heading">Built to be checkable</h2>
        <p className="home__lede">
          Every number carries its source, its freshness and its confidence. Where coverage is
          incomplete, the product leads with that fact rather than hiding it.
        </p>
        {/*
          Split, because a list of sources reads as a list of things that are running.

          National Highways and Street Manager are implemented and contract-tested and no job
          calls them; TfL's live vehicle path is written and unproven. Listing those beside BODS
          and NaPTAN claimed a breadth of live coverage the deployment does not have — on the one
          page whose subject is that every number carries its provenance.
        */}
        <ul className="home__sources">
          <li>Bus Open Data Service — timetables and vehicle locations outside London</li>
          <li>NaPTAN — the canonical identity of every stop</li>
          <li>Open-Meteo — observed and forecast weather</li>
          <li>OpenStreetMap — road network, walking network and named places</li>
          <li>Transport for London Unified API — London arrivals and disruption notices</li>
        </ul>
        <p className="muted small">
          Written and not yet running against this deployment: National Highways and Street Manager
          road context, and Environment Agency flood warnings. They are listed on the methodology
          page with what has and has not been observed. London vehicle positions are not on that
          list and never will be — TfL does not publish them, so no amount of work here produces
          one.
        </p>
        <Link to="/methodology">Read the data and methodology</Link>
      </section>
    </div>
  );
}
