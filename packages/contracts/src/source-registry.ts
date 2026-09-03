import { z } from "zod";
import { DataSourceNameSchema } from "./common.js";

/**
 * Source registry required by docs/05_DATA_SOURCES.md. Every upstream input records
 * owner, purpose, geography, licence, attribution, credential name, freshness SLA,
 * cache policy, terms notes and when its contract was last verified against the live API.
 *
 * `contractVerification.method` is deliberately explicit: "live_response" may only be set
 * when a real upstream response was actually inspected. Anything derived from published
 * documentation alone must say so, so the product never overstates its evidence.
 */

export const ContractVerificationMethodSchema = z.enum([
  "live_response",
  "published_documentation",
  "not_verified",
]);
export type ContractVerificationMethod = z.infer<typeof ContractVerificationMethodSchema>;

export const SourceRegistryEntrySchema = z.object({
  source: DataSourceNameSchema,
  displayName: z.string(),
  owner: z.string(),
  purpose: z.string(),
  geography: z.string(),
  baseUrl: z.string().url(),
  licenceUrl: z.string().url(),
  attribution: z.string(),
  /** Environment variable name only — never a value. Null when the API needs no credential. */
  credentialEnvName: z.string().nullable(),
  /** Maximum age before the UI must label data stale, in seconds. */
  freshnessSlaSeconds: z.number().int().positive(),
  /** Edge/worker cache TTL in seconds. */
  cacheTtlSeconds: z.number().int().nonnegative(),
  termsNotes: z.string(),
  contractVerification: z.object({
    method: ContractVerificationMethodSchema,
    at: z.string().nullable(),
    note: z.string(),
  }),
});
export type SourceRegistryEntry = z.infer<typeof SourceRegistryEntrySchema>;

export const SOURCE_REGISTRY: readonly SourceRegistryEntry[] = [
  {
    source: "bods",
    displayName: "Bus Open Data Service (BODS)",
    owner: "Department for Transport",
    purpose: "Timetables (TransXChange), bus location data (SIRI-VM/GTFS-RT), fares feeds",
    geography: "England outside London",
    baseUrl: "https://data.bus-data.dft.gov.uk/api/v1/",
    licenceUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    attribution:
      "Contains public sector information licensed under the Open Government Licence v3.0",
    credentialEnvName: "BODS_API_KEY",
    freshnessSlaSeconds: 180,
    cacheTtlSeconds: 20,
    termsNotes:
      "Free registered API key. BODS consumer guidance asks that the central live data is requested no more frequently than once every five seconds; see BODS_MINIMUM_REQUEST_INTERVAL_MS, which is enforced at the point of request. Bounded national collection only on a schedule; user requests are served viewport-scoped from cache.",
    contractVerification: {
      method: "published_documentation",
      at: null,
      note: "Live verification blocked: no BODS_API_KEY provisioned and data.bus-data.dft.gov.uk is unreachable from the build sandbox (egress policy).",
    },
  },
  {
    source: "tfl",
    displayName: "Transport for London Unified API",
    owner: "Transport for London",
    purpose: "London arrivals, vehicle positions, routes/schedules, disruptions",
    geography: "Greater London",
    baseUrl: "https://api.tfl.gov.uk/",
    licenceUrl: "https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service",
    attribution:
      "Powered by TfL Open Data. Contains OS data © Crown copyright and database rights.",
    credentialEnvName: "TFL_APP_KEY",
    freshnessSlaSeconds: 120,
    cacheTtlSeconds: 20,
    termsNotes:
      "Free registered app key with per-minute rate limits. Attribution is mandatory under the TfL open data terms.",
    contractVerification: {
      method: "published_documentation",
      at: null,
      note: "Live verification blocked: no TFL_APP_KEY provisioned and api.tfl.gov.uk is unreachable from the build sandbox (egress policy).",
    },
  },
  {
    source: "naptan",
    displayName: "NaPTAN",
    owner: "Department for Transport",
    purpose: "Canonical stop identity: ATCO codes, names, coordinates, bearings, status",
    geography: "England (Great Britain dataset, filtered)",
    baseUrl: "https://naptan.api.dft.gov.uk/v1/",
    licenceUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    attribution:
      "Contains public sector information licensed under the Open Government Licence v3.0",
    credentialEnvName: null,
    freshnessSlaSeconds: 172800,
    cacheTtlSeconds: 3600,
    termsNotes: "Bulk download; fingerprint daily and only re-ingest on change.",
    contractVerification: {
      method: "published_documentation",
      at: null,
      note: "Live verification blocked: naptan.api.dft.gov.uk is unreachable from the build sandbox (egress policy).",
    },
  },
  {
    source: "nptg",
    displayName: "NPTG (National Public Transport Gazetteer)",
    owner: "Department for Transport",
    purpose: "Locality and administrative-area hierarchy for stops",
    geography: "England (GB dataset, filtered)",
    baseUrl: "https://naptan.api.dft.gov.uk/v1/nptg",
    licenceUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    attribution:
      "Contains public sector information licensed under the Open Government Licence v3.0",
    credentialEnvName: null,
    freshnessSlaSeconds: 604800,
    cacheTtlSeconds: 3600,
    termsNotes: "Bulk download alongside NaPTAN; used for locality hierarchy and area rollups.",
    contractVerification: {
      method: "published_documentation",
      at: null,
      note: "Live verification blocked by build-sandbox egress policy.",
    },
  },
  {
    source: "national_highways",
    displayName: "National Highways DATEX II / WebTRIS",
    owner: "National Highways",
    purpose: "Strategic road network incidents, closures, roadworks and traffic flow/speed",
    geography: "England strategic road network only (not local roads)",
    baseUrl: "https://webtris.nationalhighways.co.uk/api/v1.0/",
    licenceUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    attribution:
      "Contains public sector information licensed under the Open Government Licence v3.0",
    credentialEnvName: "NATIONAL_HIGHWAYS_API_KEY",
    freshnessSlaSeconds: 900,
    cacheTtlSeconds: 300,
    termsNotes:
      "Coverage is the strategic road network only; enrichment must never imply local street coverage.",
    contractVerification: {
      method: "published_documentation",
      at: null,
      note: "Live verification blocked by build-sandbox egress policy; no credential provisioned.",
    },
  },
  {
    source: "street_manager",
    displayName: "Street Manager",
    owner: "Department for Transport",
    purpose: "Planned and in-progress street works permits",
    geography: "England",
    baseUrl: "https://api.street-manager.service.gov.uk/",
    licenceUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    attribution:
      "Contains public sector information licensed under the Open Government Licence v3.0",
    credentialEnvName: "STREET_MANAGER_API_KEY",
    freshnessSlaSeconds: 3600,
    cacheTtlSeconds: 900,
    termsNotes:
      "Ingest only via authorised published access. Works are corroborating evidence, never proof of causation.",
    contractVerification: {
      method: "published_documentation",
      at: null,
      note: "Live verification blocked by build-sandbox egress policy; no authorised access provisioned.",
    },
  },
  {
    source: "osm",
    displayName: "OpenStreetMap",
    owner: "OpenStreetMap contributors",
    purpose: "Road graph, walking network, speed-limit context, map tiles",
    geography: "England",
    baseUrl: "https://overpass-api.de/api/",
    licenceUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    attribution: "© OpenStreetMap contributors, ODbL",
    credentialEnvName: null,
    freshnessSlaSeconds: 2592000,
    cacheTtlSeconds: 86400,
    termsNotes:
      "ODbL attribution required. Do not overload public Overpass/tile endpoints: extract once per schedule, cache derived artifacts, and use a licence-compliant no-cost tile style.",
    contractVerification: {
      method: "published_documentation",
      at: null,
      note: "Live verification blocked by build-sandbox egress policy.",
    },
  },
  {
    source: "open_meteo",
    displayName: "Open-Meteo",
    owner: "Open-Meteo",
    purpose: "Observed and forecast weather on a spatial grid",
    geography: "England",
    baseUrl: "https://api.open-meteo.com/v1/",
    licenceUrl: "https://open-meteo.com/en/license",
    attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
    credentialEnvName: null,
    freshnessSlaSeconds: 3600,
    cacheTtlSeconds: 1800,
    termsNotes:
      "Free non-commercial tier is rate limited; grid-cell and time bucketing keeps calls far below the limit.",
    contractVerification: {
      method: "published_documentation",
      at: null,
      note: "Live verification blocked by build-sandbox egress policy (api.open-meteo.com CONNECT denied).",
    },
  },
  {
    source: "environment_agency",
    displayName: "Environment Agency Real Time flood-monitoring API",
    owner: "Environment Agency",
    purpose: "Official flood alerts, warnings, flood areas and river levels",
    geography: "England",
    baseUrl: "https://environment.data.gov.uk/flood-monitoring/",
    licenceUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    attribution:
      "This uses Environment Agency flood and river level data from the real-time data API (Beta), licensed under the Open Government Licence v3.0",
    credentialEnvName: null,
    freshnessSlaSeconds: 1800,
    cacheTtlSeconds: 600,
    termsNotes:
      'Only an active EA notice may be called a "flood warning"; anything derived must be worded as elevated risk.',
    contractVerification: {
      method: "published_documentation",
      at: null,
      note: "Live verification blocked by build-sandbox egress policy (environment.data.gov.uk CONNECT denied).",
    },
  },
] as const;

/**
 * BODS asks consumers not to request the central live data more often than once every five
 * seconds. It is a request interval rather than a quota, so no per-run or per-day cap expresses
 * it: a collector well inside its budget can still breach the interval by issuing a burst.
 *
 * Enforced by the collection run, and recorded in the budget registry as 12 requests per minute.
 */
export const BODS_MINIMUM_REQUEST_INTERVAL_MS = 5_000;

export function getSourceRegistryEntry(source: string): SourceRegistryEntry | undefined {
  return SOURCE_REGISTRY.find((entry) => entry.source === source);
}

/** Attribution strings that must be surfaced in-product wherever the source contributes. */
export function attributionsFor(sources: readonly string[]): string[] {
  return [
    ...new Set(sources.map((s) => getSourceRegistryEntry(s)?.attribution).filter(Boolean)),
  ] as string[];
}
