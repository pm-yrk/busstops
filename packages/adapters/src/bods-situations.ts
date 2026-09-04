import { XMLParser } from "fast-xml-parser";
import type {
  AffectedRoute,
  AffectedStop,
  DisruptionLifecycle,
  DisruptionNotice,
  DisruptionReason,
  DisruptionSeverity,
} from "@busstops/contracts";
import { child, dig, many, text, type XmlValue } from "./xml.js";

/**
 * BODS SIRI-SX — the disruption notices operators actually publish.
 *
 * Verified against the live endpoint from a GitHub runner on 2026-09-04: `/api/v1/siri-sx/`
 * answered 200 `text/xml`, 6,016,038 bytes, a `ServiceDelivery` from `DepartmentForTransport`.
 * (`/api/v1/disruptions/` answered 404 on the same run, so this is the endpoint that exists.)
 *
 * The rule this adapter is built around: nothing is invented. A situation with no stated reason
 * gets `reason: null`, a situation with no severity gets `unknown`, and a validity period with no
 * end stays open-ended. A passenger reading "cancelled — vandalism" when the operator never said
 * why is worse served than one reading "cancelled".
 */

export const BODS_SITUATIONS_URL = "https://data.bus-data.dft.gov.uk/api/v1/siri-sx/";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

/**
 * SIRI's severity enumeration, collapsed onto the four the product shows.
 *
 * `noImpact` is deliberately "information" rather than dropped: an operator saying a thing is
 * happening but not affecting service is still worth a line, and hiding it would make the list
 * disagree with the operator's own page.
 */
const SEVERITY: Record<string, DisruptionSeverity> = {
  verySlight: "minor",
  slight: "minor",
  normal: "moderate",
  severe: "severe",
  verySevere: "severe",
  noImpact: "information",
  undefined: "unknown",
  unknown: "unknown",
};

/** SIRI Progress values, mapped to the word the product uses. */
const LIFECYCLE: Record<string, DisruptionLifecycle> = {
  draft: "planned",
  pendingApproval: "planned",
  approvedDraft: "planned",
  open: "open",
  published: "open",
  closing: "open",
  closed: "closed",
};

/** The reason elements SIRI defines, in the order a publisher is most likely to have used one. */
const REASON_ELEMENTS = [
  "MiscellaneousReason",
  "PersonnelReason",
  "EquipmentReason",
  "EnvironmentReason",
  "UndefinedReason",
] as const;

export interface SituationsParseResult {
  situations: XmlValue[];
  responseTimestamp: string | null;
  /** Why a document yielded nothing, so an empty list is never mistaken for a quiet network. */
  problem: string | null;
}

export function parseSiriSx(xml: string): SituationsParseResult {
  let document: XmlValue;
  try {
    document = parser.parse(xml) as XmlValue;
  } catch {
    return { situations: [], responseTimestamp: null, problem: "unparseable XML" };
  }

  const delivery = dig(document, "Siri", "ServiceDelivery");
  if (delivery === undefined) {
    return { situations: [], responseTimestamp: null, problem: "no ServiceDelivery" };
  }

  const situations = many(child(delivery, "SituationExchangeDelivery")).flatMap((exchange) =>
    many(dig(exchange, "Situations", "PtSituationElement")),
  );

  return {
    situations,
    responseTimestamp: text(child(delivery, "ResponseTimestamp")) ?? null,
    problem: null,
  };
}

function readReason(situation: XmlValue): DisruptionReason | null {
  for (const element of REASON_ELEMENTS) {
    const value = text(child(situation, element));
    // "unknown" is SIRI's way of saying the publisher did not give a reason. It is not a reason.
    if (value !== undefined && value.toLowerCase() !== "unknown") {
      return { category: element, value };
    }
  }
  return null;
}

/** Every consequence's affected networks, stops, operators and places, flattened. */
function readAffected(situation: XmlValue): {
  routes: AffectedRoute[];
  stops: AffectedStop[];
  areas: string[];
  severity: DisruptionSeverity;
  advice?: string;
} {
  const routes = new Map<string, AffectedRoute>();
  const stops = new Map<string, AffectedStop>();
  const areas = new Set<string>();
  let severity: DisruptionSeverity = "unknown";
  let advice: string | undefined;

  const rank: DisruptionSeverity[] = ["unknown", "information", "minor", "moderate", "severe"];

  for (const consequence of many(dig(situation, "Consequences", "Consequence"))) {
    const published = text(child(consequence, "Severity"));
    const mapped = published === undefined ? "unknown" : (SEVERITY[published] ?? "unknown");
    // The worst consequence is the one that describes the situation to a passenger.
    if (rank.indexOf(mapped) > rank.indexOf(severity)) severity = mapped;

    advice ??= text(dig(consequence, "Advice", "Details"));

    const affects = child(consequence, "Affects");

    for (const network of many(dig(affects, "Networks", "AffectedNetwork"))) {
      for (const line of many(child(network, "AffectedLine"))) {
        const lineRef = text(dig(line, "LineRef")) ?? text(dig(line, "AffectedLine", "LineRef"));
        const publishedLineName = text(child(line, "PublishedLineName"));
        const operatorRef = text(dig(line, "AffectedOperator", "OperatorRef"));
        const operatorName = text(dig(line, "AffectedOperator", "OperatorName"));
        const key = `${operatorRef ?? ""}:${lineRef ?? publishedLineName ?? ""}`;
        if (key === ":") continue;
        // Merged, not replaced. A situation often names the same line in several consequences,
        // and the later mentions are usually the sparser ones — a plain `set` would let a
        // consequence that gave only a LineRef erase the operator name an earlier one carried.
        routes.set(key, {
          ...routes.get(key),
          ...(lineRef === undefined ? {} : { lineRef }),
          ...(publishedLineName === undefined ? {} : { publishedLineName }),
          ...(operatorRef === undefined ? {} : { operatorRef }),
          ...(operatorName === undefined ? {} : { operatorName }),
          serviceRouteId: null,
        });
      }
    }

    for (const stop of many(dig(affects, "StopPoints", "AffectedStopPoint"))) {
      const atcoCode = text(child(stop, "StopPointRef"));
      if (!atcoCode) continue;
      const name = text(child(stop, "StopPointName"));
      stops.set(atcoCode, { atcoCode, ...(name === undefined ? {} : { name }) });
    }

    for (const place of many(dig(affects, "Places", "AffectedPlace"))) {
      const name = text(dig(place, "PlaceName")) ?? text(dig(place, "PlaceRef"));
      if (name) areas.add(name);
    }
    for (const area of many(dig(affects, "Areas", "AffectedArea"))) {
      const name = text(child(area, "AreaName")) ?? text(child(area, "AreaRef"));
      if (name) areas.add(name);
    }
  }

  return {
    routes: [...routes.values()],
    stops: [...stops.values()],
    areas: [...areas],
    severity,
    ...(advice === undefined ? {} : { advice }),
  };
}

function isoOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export interface NormalizeSituationsOptions {
  retrievedAt: string;
  /** Situations whose validity window closed before this are dropped. Defaults to `retrievedAt`. */
  now?: Date;
  /** Cap on how many notices to keep, newest-updated first. */
  limit?: number;
}

export interface NormalizeSituationsResult {
  notices: DisruptionNotice[];
  /** Situations that could not be read, with the reason — counted, never silently dropped. */
  rejected: Array<{ reason: string; sourceRef?: string }>;
  responseTimestamp: string | null;
  /** Total situations the document offered, before filtering. */
  offered: number;
}

export function normalizeSiriSx(
  xml: string,
  options: NormalizeSituationsOptions,
): NormalizeSituationsResult {
  const { situations, responseTimestamp, problem } = parseSiriSx(xml);
  const now = options.now ?? new Date(options.retrievedAt);
  const rejected: NormalizeSituationsResult["rejected"] = [];
  if (problem) rejected.push({ reason: problem });

  const notices: DisruptionNotice[] = [];

  for (const situation of situations) {
    const sourceRef = text(child(situation, "SituationNumber"));
    if (!sourceRef) {
      rejected.push({ reason: "no SituationNumber" });
      continue;
    }

    const summary = text(child(situation, "Summary"));
    if (!summary) {
      // A notice with nothing to say cannot be shown to anyone, and guessing a headline from the
      // reason code would be writing the operator's announcement for them.
      rejected.push({ reason: "no Summary", sourceRef });
      continue;
    }

    const validity = many(child(situation, "ValidityPeriod"))[0];
    const startsAt = isoOrNull(text(child(validity, "StartTime")));
    const endsAt = isoOrNull(text(child(validity, "EndTime")));
    if (endsAt !== null && new Date(endsAt).getTime() < now.getTime()) {
      rejected.push({ reason: "validity period already ended", sourceRef });
      continue;
    }

    const progress = text(child(situation, "Progress"));
    const planned = text(child(situation, "Planned")) === "true";
    const lifecycle: DisruptionLifecycle =
      (progress === undefined ? undefined : LIFECYCLE[progress]) ??
      (planned ? "planned" : "unknown");
    if (lifecycle === "closed") {
      rejected.push({ reason: "closed by the publisher", sourceRef });
      continue;
    }

    const affected = readAffected(situation);
    const infoLinks = many(dig(situation, "InfoLinks", "InfoLink"))
      .map((link) => ({
        url: text(child(link, "Uri")) ?? "",
        label: text(child(link, "Label")),
      }))
      .filter((link) => /^https?:\/\//i.test(link.url))
      .map((link) => ({
        url: link.url,
        ...(link.label === undefined ? {} : { label: link.label }),
      }));

    const publisher = text(child(situation, "ParticipantRef"));
    const description = text(child(situation, "Description"));

    notices.push({
      id: `bods-sx:${sourceRef}`,
      source: "bods_situations",
      sourceRef,
      ...(publisher === undefined ? {} : { publisher }),
      officialStatus: "official",
      lifecycle,
      severity: affected.severity,
      summary,
      ...(description === undefined ? {} : { description }),
      ...(affected.advice === undefined ? {} : { advice: affected.advice }),
      reason: readReason(situation),
      startsAt,
      endsAt,
      updatedAt:
        isoOrNull(text(child(situation, "VersionedAtTime"))) ??
        isoOrNull(text(child(situation, "CreationTime"))),
      affectedRoutes: affected.routes,
      affectedStops: affected.stops,
      affectedAreas: affected.areas,
      infoLinks,
      attribution: "Bus Open Data Service (Department for Transport), Open Government Licence v3.0",
      provenance: {
        source: "bods",
        retrievedAt: options.retrievedAt,
        externalIds: [{ source: "bods_situation", id: sourceRef }],
      },
    });
  }

  // Newest change first: what an operator has just said is what a passenger needs now.
  notices.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  return {
    notices: options.limit === undefined ? notices : notices.slice(0, options.limit),
    rejected,
    responseTimestamp,
    offered: situations.length,
  };
}
