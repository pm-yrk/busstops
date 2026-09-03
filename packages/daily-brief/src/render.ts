import type { DailyBriefSnapshot } from "@busstops/contracts";

/**
 * Daily Brief rendering (docs/12_DAILY_BRIEF.md "Email engineering").
 *
 * Table-based layout with inline styles, because that is what actually survives Outlook, Gmail's
 * style stripping and a decade of divergent email clients. Everything is live text: a dashboard
 * rendered as an image is unreadable to a screen reader, unusable with images off, and illegible
 * when someone's client scales it — and a brief nobody can read is worse than no brief.
 *
 * Charts degrade to numbers and bars built from table cells. Both parts are derived from the same
 * frozen snapshot, so the HTML and the plain text can never disagree.
 */

export interface RenderOptions {
  /** Absolute base URL for links back into Pro. */
  baseUrl: string;
  /** One-click unsubscribe URL, unique per recipient and rotated on use. */
  unsubscribeUrl: string;
  organisationName: string | null;
  /** Set when the brief is being sent under a limited-data label. */
  limitedData: boolean;
}

const INK = "#111111";
const MUTED = "#66645f";
const CANVAS = "#f7f6f1";
const RED = "#e5242a";
const HAIRLINE = "#dad8d1";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(0)}%`;
}

function seconds(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}s`;
}

function points(value: number | null): string {
  return value === null ? "—" : String(Math.round(value));
}

/**
 * A bar drawn from two table cells, which is the only chart primitive that renders identically
 * everywhere. Falls back to the number alone when there is nothing to draw.
 */
function bar(value: number | null, max: number): string {
  if (value === null || max <= 0) return "";
  const filled = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:4px;">` +
    `<tr>` +
    `<td width="${filled}%" style="background:${INK};height:6px;font-size:0;line-height:0;">&nbsp;</td>` +
    `<td width="${100 - filled}%" style="background:${HAIRLINE};height:6px;font-size:0;line-height:0;">&nbsp;</td>` +
    `</tr></table>`
  );
}

function metricCell(label: string, value: string, detail: string, barHtml = ""): string {
  return (
    `<td style="padding:12px;border:1px solid ${HAIRLINE};vertical-align:top;width:33%;">` +
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};">${escapeHtml(label)}</div>` +
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:26px;color:${INK};padding-top:4px;">${escapeHtml(value)}</div>` +
    barHtml +
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:${MUTED};padding-top:4px;">${escapeHtml(detail)}</div>` +
    `</td>`
  );
}

export function renderHtml(snapshot: DailyBriefSnapshot, options: RenderOptions): string {
  const scope = options.organisationName ?? "England";
  const change = snapshot.yesterday.networkHealthChangeVsBaseline;

  const limitedBanner = options.limitedData
    ? `<tr><td style="padding:12px;background:#fbf1dc;border-left:4px solid #8a5a00;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${INK};">` +
      `<strong>Limited data.</strong> ${escapeHtml(snapshot.coverageCaveat ?? "Coverage was below the level needed for a full brief.")}` +
      `</td></tr>`
    : "";

  const caveat =
    snapshot.coverageCaveat && !options.limitedData
      ? `<tr><td style="padding:12px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:${MUTED};">${escapeHtml(snapshot.coverageCaveat)}</td></tr>`
      : "";

  const corridors = snapshot.today.highestRiskCorridors
    .map(
      (corridor) =>
        `<tr>` +
        `<td style="padding:8px;border-bottom:1px solid ${HAIRLINE};font-family:Helvetica,Arial,sans-serif;font-size:13px;">${escapeHtml(corridor.corridorId)}</td>` +
        `<td style="padding:8px;border-bottom:1px solid ${HAIRLINE};font-family:Helvetica,Arial,sans-serif;font-size:13px;">${escapeHtml(corridor.probabilityBand)}</td>` +
        `<td style="padding:8px;border-bottom:1px solid ${HAIRLINE};font-family:Helvetica,Arial,sans-serif;font-size:13px;text-align:right;">${corridor.expectedAdditionalMinutesLow}–${corridor.expectedAdditionalMinutesHigh} min</td>` +
        `</tr>`,
    )
    .join("");

  const priorities = snapshot.today.investigationPriorities
    .map(
      (priority) =>
        `<li style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${INK};padding-bottom:6px;">${escapeHtml(priority)}</li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bus Stops Pro — Daily Operations Brief, ${escapeHtml(snapshot.localDate)}</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Yesterday's performance. Today's outlook. ${escapeHtml(snapshot.localDate)}.</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${CANVAS};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;background:#ffffff;">

<tr><td style="padding:20px;border-bottom:3px solid ${INK};">
<div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:${RED};">Bus Stops Pro</div>
<h1 style="margin:4px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:24px;color:${INK};">Daily Operations Brief</h1>
<div style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${MUTED};padding-top:6px;">
${escapeHtml(scope)} · ${escapeHtml(snapshot.localDate)} · generated ${escapeHtml(snapshot.generatedAt)}
</div>
</td></tr>

${limitedBanner}

<tr><td style="padding:20px 20px 0;">
<h2 style="margin:0 0 12px;font-family:Helvetica,Arial,sans-serif;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:${INK};">Yesterday</h2>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
${metricCell(
  "Network health",
  points(snapshot.yesterday.networkHealth),
  change === null
    ? "no comparable baseline"
    : `${Math.abs(Math.round(change))} ${change >= 0 ? "above" : "below"} baseline`,
  bar(snapshot.yesterday.networkHealth, 100),
)}
${metricCell(
  "Punctuality",
  percent(snapshot.yesterday.punctuality),
  `${snapshot.yesterday.denominator.toLocaleString("en-GB")} observations`,
  bar(snapshot.yesterday.punctuality, 1),
)}
${metricCell(
  "Reliability",
  percent(snapshot.yesterday.reliability),
  `${snapshot.yesterday.denominator.toLocaleString("en-GB")} observations`,
  bar(snapshot.yesterday.reliability, 1),
)}
</tr>
<tr>
${metricCell("Median delay", seconds(snapshot.yesterday.medianDelaySeconds), "actual minus scheduled")}
${metricCell(
  "Routes needing attention",
  String(snapshot.yesterday.requiresAttentionRouteIds.length),
  snapshot.yesterday.requiresAttentionRouteIds.length === 0
    ? "none with comparable coverage"
    : "below comparable baseline",
)}
${metricCell(
  "Key events",
  String(snapshot.yesterday.keyEventIds.length),
  "bunching, gaps and diversions",
)}
</tr>
</table>
</td></tr>

${caveat}

<tr><td style="padding:20px;">
<h2 style="margin:0 0 12px;font-family:Helvetica,Arial,sans-serif;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:${INK};">Today's outlook</h2>
<p style="margin:0 0 12px;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:${INK};line-height:1.5;">
<strong>${escapeHtml(snapshot.today.riskBand)} risk</strong>, at ${escapeHtml(snapshot.today.confidence.level)} confidence.
${escapeHtml(snapshot.today.weatherWindowSummary)}
</p>
${
  corridors.length > 0
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<th align="left" style="padding:8px;font-family:Helvetica,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:${MUTED};border-bottom:2px solid ${INK};">Corridor</th>
<th align="left" style="padding:8px;font-family:Helvetica,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:${MUTED};border-bottom:2px solid ${INK};">Probability</th>
<th align="right" style="padding:8px;font-family:Helvetica,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:${MUTED};border-bottom:2px solid ${INK};">Extra time</th>
</tr>
${corridors}
</table>`
    : `<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${MUTED};">No corridor is showing elevated risk today.</p>`
}
</td></tr>

<tr><td style="padding:0 20px 20px;">
<h2 style="margin:0 0 12px;font-family:Helvetica,Arial,sans-serif;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:${INK};">Worth looking at</h2>
<ul style="margin:0;padding-left:20px;">${priorities}</ul>
</td></tr>

<tr><td style="padding:0 20px 20px;">
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${INK};line-height:1.55;">${escapeHtml(snapshot.narrative)}</p>
</td></tr>

<tr><td style="padding:16px 20px;border-top:1px solid ${HAIRLINE};background:${CANVAS};">
<p style="margin:0 0 8px;font-family:Helvetica,Arial,sans-serif;font-size:12px;">
<a href="${escapeHtml(options.baseUrl)}/pro" style="color:${INK};">Open Bus Stops Pro</a> ·
<a href="${escapeHtml(options.baseUrl)}/methodology" style="color:${INK};">How these figures are produced</a> ·
<a href="${escapeHtml(options.unsubscribeUrl)}" style="color:${INK};">Unsubscribe</a>
</p>
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:${MUTED};line-height:1.5;">
Contains public sector information licensed under the Open Government Licence v3.0.
Bus location data from the Bus Open Data Service and Transport for London.
We send this because you asked us to; unsubscribing takes one click and takes effect immediately.
</p>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

/**
 * The plain-text part. Not a stripped-down afterthought: some recipients read only this, and it
 * carries the same figures, the same caveats and the same unsubscribe link.
 */
export function renderText(snapshot: DailyBriefSnapshot, options: RenderOptions): string {
  const scope = options.organisationName ?? "England";
  const change = snapshot.yesterday.networkHealthChangeVsBaseline;
  const lines: string[] = [];

  lines.push("BUS STOPS PRO — DAILY OPERATIONS BRIEF");
  lines.push(`${scope} · ${snapshot.localDate} · generated ${snapshot.generatedAt}`);
  lines.push("");

  if (options.limitedData) {
    lines.push("LIMITED DATA");
    lines.push(snapshot.coverageCaveat ?? "Coverage was below the level needed for a full brief.");
    lines.push("");
  }

  lines.push("YESTERDAY");
  lines.push(
    `  Network health:  ${points(snapshot.yesterday.networkHealth)}` +
      (change === null
        ? " (no comparable baseline)"
        : ` (${Math.abs(Math.round(change))} ${change >= 0 ? "above" : "below"} baseline)`),
  );
  lines.push(
    `  Punctuality:     ${percent(snapshot.yesterday.punctuality)} from ${snapshot.yesterday.denominator.toLocaleString("en-GB")} observations`,
  );
  lines.push(`  Reliability:     ${percent(snapshot.yesterday.reliability)}`);
  lines.push(`  Median delay:    ${seconds(snapshot.yesterday.medianDelaySeconds)}`);
  lines.push(`  Key events:      ${snapshot.yesterday.keyEventIds.length}`);

  if (snapshot.yesterday.dataQualityIssues.length > 0) {
    lines.push("");
    lines.push("  Data quality:");
    for (const issue of snapshot.yesterday.dataQualityIssues) lines.push(`    - ${issue}`);
  }

  lines.push("");
  lines.push("TODAY'S OUTLOOK");
  lines.push(
    `  ${snapshot.today.riskBand} risk, at ${snapshot.today.confidence.level} confidence.`,
  );
  lines.push(`  ${snapshot.today.weatherWindowSummary}`);

  if (snapshot.today.highestRiskCorridors.length > 0) {
    lines.push("");
    lines.push("  Highest-risk corridors:");
    for (const corridor of snapshot.today.highestRiskCorridors) {
      lines.push(
        `    - ${corridor.corridorId}: ${corridor.probabilityBand}, adding roughly ${corridor.expectedAdditionalMinutesLow}-${corridor.expectedAdditionalMinutesHigh} minutes`,
      );
    }
  }

  lines.push("");
  lines.push("WORTH LOOKING AT");
  for (const priority of snapshot.today.investigationPriorities) {
    lines.push(`  - ${priority}`);
  }

  if (snapshot.coverageCaveat && !options.limitedData) {
    lines.push("");
    lines.push("COVERAGE");
    lines.push(`  ${snapshot.coverageCaveat}`);
  }

  lines.push("");
  lines.push(snapshot.narrative);
  lines.push("");
  lines.push(`Open Bus Stops Pro:   ${options.baseUrl}/pro`);
  lines.push(`How this is measured: ${options.baseUrl}/methodology`);
  lines.push(`Unsubscribe:          ${options.unsubscribeUrl}`);
  lines.push("");
  lines.push("Contains public sector information licensed under the Open Government Licence v3.0.");
  lines.push(
    "We send this because you asked us to; unsubscribing takes one click and takes effect immediately.",
  );

  return lines.join("\n");
}

export function subjectLine(snapshot: DailyBriefSnapshot, limitedData: boolean): string {
  const health =
    snapshot.yesterday.networkHealth === null
      ? "limited data"
      : `network health ${Math.round(snapshot.yesterday.networkHealth)}`;
  return `${limitedData ? "[Limited data] " : ""}Bus Stops Pro — ${snapshot.localDate}: ${health}, ${snapshot.today.riskBand} risk today`;
}
