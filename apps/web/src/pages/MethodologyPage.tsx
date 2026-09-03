import { SOURCE_REGISTRY } from "@busstops/contracts";
import "./MethodologyPage.css";

/**
 * Data and methodology (docs/03_SITE_MAP_AND_UX.md, docs/14_SECURITY.md "legal/trust pages").
 *
 * This page is generated from the same source registry the pipelines use, so it cannot drift
 * from reality: if an adapter changes its licence, attribution or freshness SLA, this page
 * changes with it. Verification status is stated plainly, including where it is absent.
 */

export function MethodologyPage() {
  return (
    <div className="page methodology">
      <h1>Data and methodology</h1>
      <p className="methodology__lede">
        Every figure in Bus Stops. comes from a named public source, carries the time it was
        observed, and states how confident we are. This page explains where the data comes from and
        how the derived numbers are produced.
      </p>

      <section aria-labelledby="sources-heading">
        <h2 id="sources-heading">Sources</h2>
        <div className="methodology__table-wrap">
          <table className="methodology__table">
            <caption className="visually-hidden">
              Data sources, licences and update frequency
            </caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">What it provides</th>
                <th scope="col">Coverage</th>
                <th scope="col">Freshness target</th>
                <th scope="col">Licence</th>
                <th scope="col">Contract verified</th>
              </tr>
            </thead>
            <tbody>
              {SOURCE_REGISTRY.map((entry) => (
                <tr key={entry.source}>
                  <th scope="row">{entry.displayName}</th>
                  <td>{entry.purpose}</td>
                  <td>{entry.geography}</td>
                  <td>{formatSla(entry.freshnessSlaSeconds)}</td>
                  <td>
                    <a href={entry.licenceUrl} target="_blank" rel="noopener noreferrer external">
                      Licence
                    </a>
                  </td>
                  <td>
                    {entry.contractVerification.method === "live_response"
                      ? `Against a live response${entry.contractVerification.at ? ` on ${entry.contractVerification.at.slice(0, 10)}` : ""}`
                      : "Against published documentation only"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>Attribution</h3>
        <ul className="methodology__attribution">
          {[...new Set(SOURCE_REGISTRY.map((entry) => entry.attribution))].map((attribution) => (
            <li key={attribution}>{attribution}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="definitions-heading">
        <h2 id="definitions-heading">What the words mean</h2>
        <dl className="methodology__definitions">
          <dt>Live</dt>
          <dd>
            A prediction or position published by the operator's own real-time feed, with the age of
            that observation shown alongside it.
          </dd>

          <dt>Scheduled</dt>
          <dd>The registered timetable time, used when no live data exists for that journey.</dd>

          <dt>Estimated</dt>
          <dd>
            A time we derived by combining a live position with the timetable. It is an estimate,
            not an operator prediction, and is labelled as such.
          </dd>

          <dt>Inferred</dt>
          <dd>
            Something we concluded from the data rather than observed directly — for example, a
            London vehicle's position, which we derive from arrival predictions because the Unified
            API does not publish vehicle positions.
          </dd>

          <dt>Forecast</dt>
          <dd>A statement about the future, always with a range and a confidence level.</dd>
        </dl>
      </section>

      <section aria-labelledby="metrics-heading">
        <h2 id="metrics-heading">How the metrics are calculated</h2>

        <h3>Delay</h3>
        <p>
          Observed or predicted time minus the scheduled time at the same point, in seconds.
          Positive means late, negative means early. We report the median as well as the mean,
          because a handful of very late journeys distort an average.
        </p>

        <h3>Punctuality</h3>
        <p>
          The share of eligible observations inside the on-time window, which defaults to one minute
          early to five minutes late. The exact window, the denominator and the coverage are always
          shown with the figure, because the same network can look very different under a different
          definition.
        </p>

        <h3>Reliability</h3>
        <p>
          Observed eligible journeys divided by scheduled eligible journeys. A journey we did not
          observe is not the same as a cancelled one, and we never label missing telemetry as a
          cancellation.
        </p>

        <h3>Typical versus abnormal</h3>
        <p>
          Current conditions are compared with a baseline built from the same corridor, direction,
          day type and time of day over recent weeks. Below the minimum comparable sample we say
          “insufficient baseline” instead of publishing a classification we cannot support.
        </p>

        <h3>Confidence</h3>
        <p>
          Every derived result scores source freshness, match quality, sample size and diversity,
          persistence, baseline adequacy and corroboration. Confidence can never exceed the weakest
          essential piece of evidence.
        </p>
      </section>

      <section aria-labelledby="limits-heading">
        <h2 id="limits-heading">What this product does not do</h2>
        <ul>
          <li>
            It does not replay history. Raw vehicle positions are deleted automatically within 48
            hours, and there is no network replay feature.
          </li>
          <li>
            It does not identify drivers or individuals. Vehicle references are opaque and rotate,
            and speed observations are never presented as evidence about a person.
          </li>
          <li>
            It does not claim a cause without official evidence. Roadworks near a delay are shown as
            corroboration, not as the reason for it.
          </li>
          <li>
            It does not sell tickets. Where we link to an operator or authorised seller, the seller
            is named and the link is verified.
          </li>
        </ul>
      </section>
    </div>
  );
}

function formatSla(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86400)} days`;
}
