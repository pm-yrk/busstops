import { Link } from "react-router-dom";
import type { DisruptionNotice, DisruptionSeverity } from "@busstops/contracts";
import "./OfficialNotices.css";
import { PixelSectionHeading } from "./pixel/PixelSectionHeading.js";
import { PixelClock, PixelCone, PixelPin, PixelRouteMark, PixelWarning } from "./pixel/PixelArt.js";

/**
 * What operators and authorities have actually said.
 *
 * Kept visually and structurally apart from anything Bus Stops inferred. A passenger deciding
 * whether to wait needs to know the difference between "First Leeds says this route is diverted"
 * and "we have noticed these buses running slowly", and the surest way to lose that distinction
 * is to render them in the same list.
 */

const SEVERITY_LABEL: Record<DisruptionSeverity, string> = {
  severe: "Severe",
  moderate: "Moderate",
  minor: "Minor",
  information: "Information",
  unknown: "Not stated",
};

function whenLabel(notice: DisruptionNotice, now: Date): string {
  const parts: string[] = [];
  if (notice.startsAt) {
    const starts = new Date(notice.startsAt);
    parts.push(
      starts.getTime() > now.getTime()
        ? `From ${starts.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
        : `Since ${starts.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`,
    );
  }
  parts.push(
    notice.endsAt
      ? `until ${new Date(notice.endsAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
      : // Said rather than left blank: an operator who has not given an end has said something.
        "no end time given",
  );
  return parts.join(", ");
}

export function OfficialNoticeCard({ notice, now }: { notice: DisruptionNotice; now: Date }) {
  return (
    <li className={`notice notice--${notice.severity}`}>
      <div className="notice__head">
        {/*
          A mark for what kind of thing this is, sized to sit beside the severity rather than
          above the words.

          Chosen from the notice's own `reason`, not from its text: a cone means the publisher
          said roadworks, and a warning means it said something else or nothing. Guessing a
          category from the summary would put a picture of roadworks on a notice about a
          demonstration.
        */}
        {notice.reason?.value?.toLowerCase().includes("road") ? (
          <PixelCone size={20} className="notice__mark" />
        ) : (
          <PixelWarning size={20} className="notice__mark" />
        )}
        <span className={`notice__severity notice__severity--${notice.severity}`}>
          {SEVERITY_LABEL[notice.severity]}
        </span>
        {notice.lifecycle === "planned" ? <span className="notice__planned">Planned</span> : null}
        <h3 className="notice__summary">{notice.summary}</h3>
      </div>

      {notice.description ? <p className="notice__description">{notice.description}</p> : null}
      {notice.advice ? <p className="notice__advice">{notice.advice}</p> : null}

      <dl className="notice__facts">
        <div>
          <dt>
            <PixelClock size={16} className="notice__fact-mark" />
            When
          </dt>
          <dd>{whenLabel(notice, now)}</dd>
        </div>
        <div>
          <dt>Reason</dt>
          {/* Never inferred. An operator who did not say why gets "Not given" here. */}
          <dd>{notice.reason ? notice.reason.value : "Not given by the publisher"}</dd>
        </div>
        {notice.affectedRoutes.length > 0 ? (
          <div>
            <dt>
              <PixelRouteMark size={16} className="notice__fact-mark" />
              Routes
            </dt>
            <dd className="notice__routes">
              {notice.affectedRoutes.map((route) => (
                <span className="notice__route" key={`${route.operatorRef}-${route.lineRef}`}>
                  {route.serviceRouteId ? (
                    <Link to={`/routes/${route.serviceRouteId}`}>
                      {route.publishedLineName ?? route.lineRef}
                    </Link>
                  ) : (
                    (route.publishedLineName ?? route.lineRef)
                  )}
                </span>
              ))}
            </dd>
          </div>
        ) : null}
        {notice.affectedStops.length > 0 ? (
          <div>
            <dt>
              <PixelPin size={16} className="notice__fact-mark" />
              Stops
            </dt>
            <dd className="notice__stops">
              {notice.affectedStops.slice(0, 6).map((stop) => (
                <Link key={stop.atcoCode} to={`/stops/${stop.atcoCode}`}>
                  {stop.name ?? stop.atcoCode}
                </Link>
              ))}
              {notice.affectedStops.length > 6 ? (
                <span className="muted small">and {notice.affectedStops.length - 6} more</span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {notice.affectedAreas.length > 0 ? (
          <div>
            <dt>Area</dt>
            <dd>{notice.affectedAreas.join(", ")}</dd>
          </div>
        ) : null}
        <div>
          <dt>Last updated by</dt>
          <dd>
            {notice.publisher ?? "the publisher"}
            {notice.updatedAt
              ? `, ${new Date(notice.updatedAt).toLocaleString("en-GB", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}`
              : ""}
          </dd>
        </div>
      </dl>

      <p className="notice__attribution small muted">
        {notice.infoLinks.length > 0 ? (
          <a href={notice.infoLinks[0]!.url} target="_blank" rel="noreferrer noopener">
            {notice.infoLinks[0]!.label ?? "Read the original notice"}
          </a>
        ) : null}
        <span>{notice.attribution}</span>
      </p>
    </li>
  );
}

export interface OfficialNoticesProps {
  notices: readonly DisruptionNotice[];
  sourcesQueried: ReadonlyArray<{
    source: string;
    outcome: "ok" | "empty" | "failed" | "not_configured";
    records: number;
    queriedAt: string;
    error?: string;
  }>;
  collectedAt: string | null;
  now?: Date;
  /** Heading level context: the page owns the h2, a stop card owns an h3. */
  headingId?: string;
}

const SOURCE_LABEL: Record<string, string> = {
  bods_situations: "Operators, via the Bus Open Data Service",
  bods_cancellations: "Cancellations, via the Bus Open Data Service",
  tfl_status: "Transport for London route status",
  tfl_disruption: "Transport for London road disruptions",
};

/**
 * The list, plus an honest account of who was asked.
 *
 * "No notices" and "nobody answered" look identical on screen unless you say which it was, and
 * that is the single most misleading thing a disruption page can do.
 */
export function OfficialNotices({
  notices,
  sourcesQueried,
  collectedAt,
  now = new Date(),
  headingId = "official-now",
}: OfficialNoticesProps) {
  const queriedAt = collectedAt ? new Date(collectedAt) : null;
  const asked = sourcesQueried.filter((source) => source.outcome !== "not_configured");
  const failed = asked.filter((source) => source.outcome === "failed");

  return (
    <section className="official-notices" aria-labelledby={headingId}>
      <header className="official-notices__header">
        <PixelSectionHeading mark="warning" id={headingId}>
          Official now
        </PixelSectionHeading>
        <p className="muted small">
          Published by operators and transport authorities. Bus Stops repeats these; it does not
          write them.
        </p>
      </header>

      {notices.length > 0 ? (
        <ul className="official-notices__list">
          {notices.map((notice) => (
            <OfficialNoticeCard key={notice.id} notice={notice} now={now} />
          ))}
        </ul>
      ) : (
        <p className="official-notices__empty">
          {asked.length === 0
            ? "No disruption source has been queried yet on this deployment."
            : failed.length === asked.length
              ? "No disruption source could be reached, so we cannot say whether anything is being reported."
              : `No current official disruption notices were returned at ${
                  queriedAt
                    ? queriedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
                    : "the last check"
                }.`}
        </p>
      )}

      <details className="official-notices__sources">
        <summary>Which sources were asked</summary>
        <ul>
          {sourcesQueried.length === 0 ? (
            <li className="muted">No source has reported in yet.</li>
          ) : (
            sourcesQueried.map((source) => (
              <li key={source.source}>
                <span className="official-notices__source-name">
                  {SOURCE_LABEL[source.source] ?? source.source}
                </span>
                <span className={`official-notices__outcome is-${source.outcome}`}>
                  {source.outcome === "ok"
                    ? `${source.records} notice${source.records === 1 ? "" : "s"}`
                    : source.outcome === "empty"
                      ? "nothing to report"
                      : source.outcome === "failed"
                        ? `could not be reached (${source.error ?? "unknown"})`
                        : "not configured on this deployment"}
                </span>
                <time dateTime={source.queriedAt} className="muted small">
                  {new Date(source.queriedAt).toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </li>
            ))
          )}
        </ul>
      </details>
    </section>
  );
}
