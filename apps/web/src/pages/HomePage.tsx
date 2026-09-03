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
        <p className="home__lede">
          Live vehicle positions, real arrivals and the reasoning behind them — for every supported
          local bus service in England, inside and outside London.
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
              position, whether other buses are moving, and any official incident — then offers real
              alternatives.
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
        <ul className="home__sources">
          <li>Bus Open Data Service — timetables and vehicle locations outside London</li>
          <li>Transport for London Unified API — London arrivals and disruptions</li>
          <li>NaPTAN — the canonical identity of every stop</li>
          <li>National Highways and Street Manager — official road context</li>
          <li>Environment Agency — official flood alerts and warnings</li>
          <li>Open-Meteo — observed and forecast weather</li>
          <li>OpenStreetMap — road and walking network</li>
        </ul>
        <Link to="/methodology">Read the data and methodology</Link>
      </section>
    </div>
  );
}
